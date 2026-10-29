/**
 * app.publish through the TS wrapper: per-topic seq, and a LISTEN app_events client (as the
 * local SSE route will be) receives the payload within 1 s.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FleetTick, MachineView } from '../../domain/fleet';
import { setupTestDb } from '../../test/db';
import { messageBytes, notifyText, publish } from './publish';
import { LOCAL_NOTIFY_CHANNEL, MAX_PAYLOAD_BYTES, type NotifyMessage } from './types';

const t = setupTestDb(import.meta.url);
let listener: pg.Client;
const received: { at: number; raw: string; msg: NotifyMessage }[] = [];

beforeAll(async () => {
  listener = new pg.Client({ connectionString: t().appUrl });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel === LOCAL_NOTIFY_CHANNEL && n.payload) {
      received.push({
        at: Date.now(),
        raw: n.payload,
        msg: JSON.parse(n.payload) as NotifyMessage,
      });
    }
  });
  await listener.query(`listen ${LOCAL_NOTIFY_CHANNEL}`);
});
afterAll(async () => {
  await listener?.end();
});

function waitFor(pred: (m: NotifyMessage) => boolean, ms: number): Promise<NotifyMessage> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = received.find((r) => pred(r.msg));
      if (hit) return resolve(hit.msg);
      if (Date.now() - started > ms) return reject(new Error(`no notification within ${ms} ms`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('app.publish', () => {
  test('a LISTEN app_events client receives the payload within 1 s, with seq', async () => {
    const tick: FleetTick = { ts: new Date().toISOString(), machines: [] };
    const sent = Date.now();
    await publish('fleet', 'tick', tick, t().pool);
    const msg = await waitFor((m) => m.topic === 'fleet' && m.event === 'tick', 1000);
    expect(Date.now() - sent).toBeLessThan(1000);
    expect(msg.payload).toEqual({ ...tick, seq: 1 });
  });

  test('seq increments per topic', async () => {
    const { pool } = t();
    await publish('admin', 'clock', { paused: true }, pool);
    await publish('admin', 'clock', { paused: false }, pool);
    await publish('fleet', 'tick', { ts: new Date().toISOString(), machines: [] }, pool);
    const seqs = await pool.query('select topic, seq from app.topic_seq order by topic');
    expect(seqs.rows).toEqual([
      { topic: 'admin', seq: '2' },
      { topic: 'fleet', seq: '2' },
    ]);
    const last = await waitFor((m) => m.topic === 'admin' && m.payload.seq === 2, 1000);
    expect(last.payload).toEqual({ paused: false, seq: 2 });
  });

  test('publishing inside a rolled-back transaction delivers nothing', async () => {
    const c = await t().pool.connect();
    try {
      await c.query('begin');
      await publish('admin', 'invalidate', { reason: 'changed' }, c);
      await c.query('rollback');
    } finally {
      c.release();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(received.some((r) => r.msg.event === 'invalidate')).toBe(false);
  });

  test('publishes inside a Drizzle transaction: delivered on commit, dropped on rollback', async () => {
    const { db } = t();
    await db.transaction(async (tx) => {
      await publish('fleet', 'tick', { ts: 'drizzle-commit', machines: [] }, tx);
    });
    const got = await waitFor((m) => m.event === 'tick' && m.payload.ts === 'drizzle-commit', 1000);
    expect(got.payload.seq).toBeGreaterThan(0);

    await expect(
      db.transaction(async (tx) => {
        await publish('fleet', 'tick', { ts: 'drizzle-rollback', machines: [] }, tx);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await new Promise((r) => setTimeout(r, 200));
    expect(received.some((r) => r.msg.payload.ts === 'drizzle-rollback')).toBe(false);
  });

  test('messageBytes matches the text Postgres builds, byte for byte', async () => {
    const samples: Record<string, unknown>[] = [
      { paused: true },
      { ts: '2026-10-28T15:00:00.000Z', machines: [] },
      { a: [1, 2.5, -3, 1e-7, 1e21, { b: null, c: [true, false] }], s: 'tab\tquote"slash\\é🚜' },
      { nested: { deeper: { deepest: [[], {}, [1, [2, [3]]]] } }, seq: 'replaced by app.publish' },
    ];
    for (const payload of samples) {
      const r = await t().pool.query(
        `select json_build_object('topic', $1::text, 'event', $2::text,
                  'payload', $3::jsonb || jsonb_build_object('seq', $4::bigint))::text as text`,
        ['fleet', 'tick', JSON.stringify(payload), 2 ** 53],
      );
      const pgText = r.rows[0].text as string;
      expect(messageBytes('fleet', 'tick', payload)).toBe(Buffer.byteLength(pgText));
      expect(Buffer.byteLength(notifyText('fleet', 'tick', payload, 2 ** 53))).toBe(
        Buffer.byteLength(pgText),
      );
    }
  });

  test('ticks around the limit either send or become invalidate; none throws', async () => {
    const machine = (i: number): MachineView => ({
      id: `0f8fad5b-d9cb-469f-a165-${String(70_000_000_000 + i).padStart(12, '0')}`,
      unitNo: `GC${i}`,
      kind: 'grain_cart',
      lng: -84.034567,
      lat: 41.912345,
      heading: 271.5,
      speedMph: 12.4,
      activity: 'transport',
      fieldId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      positionSource: 'deere_working',
      ts: '2026-10-28T15:00:00.000Z',
      status: 'active',
      stale: false,
    });
    const base: FleetTick = { ts: '', machines: Array.from({ length: 20 }, (_, i) => machine(i)) };
    // The old estimate: JSON.stringify of the wrapped message (no spaces).
    const naive = (tick: FleetTick) =>
      Buffer.byteLength(
        JSON.stringify({ topic: 'fleet', event: 'tick', payload: { ...tick, seq: 2 ** 53 } }),
      );
    const events = new Set<string>();
    // 7,400-7,600 is where the old JSON.stringify estimate let ticks through that pg_notify
    // then rejected; start lower so some ticks are really sent.
    for (let target = 6_800; target <= 7_600; target += 25) {
      const tick: FleetTick = { ...base, ts: 'x'.repeat(target - naive(base)) };
      expect(naive(tick)).toBe(target);
      const r = await publish('fleet', 'tick', tick, t().pool); // must not throw
      events.add(r.event);
      if (r.event === 'tick') {
        expect(r.bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        const got = await waitFor((m) => m.event === 'tick' && m.payload.ts === tick.ts, 1000);
        const raw = received.find((x) => x.msg === got)?.raw ?? '';
        expect(Buffer.byteLength(raw)).toBe(
          Buffer.byteLength(notifyText('fleet', 'tick', tick, got.payload.seq)),
        );
        expect(Buffer.byteLength(raw)).toBeLessThan(8_000);
      } else {
        expect(r.event).toBe('invalidate');
      }
    }
    expect(events).toEqual(new Set(['tick', 'invalidate']));
  });
});

describe('app.publish next to a realtime schema farm_app cannot see', () => {
  // The Supabase image's `postgres` database has a `realtime` schema without USAGE for
  // farm_app; test clones don't, so recreate that here.
  test('still publishes as farm_app', async () => {
    const admin = new pg.Client({ connectionString: t().adminUrl });
    await admin.connect();
    try {
      await admin.query('create schema if not exists realtime');
      await admin.query('revoke all on schema realtime from public');
    } finally {
      await admin.end();
    }
    received.length = 0;
    await publish('admin', 'clock', { paused: true }, t().pool);
    const msg = await waitFor((m) => m.topic === 'admin', 1000);
    expect(msg.payload).toMatchObject({ paused: true });
  });
});
