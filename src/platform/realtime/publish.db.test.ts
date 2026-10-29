/**
 * app.publish through the TS wrapper: per-topic seq, and a LISTEN app_events client (as the
 * local SSE route will be) receives the payload within 1 s.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FleetTick } from '../../domain/fleet';
import { setupTestDb } from '../../test/db';
import { publish } from './publish';
import { LOCAL_NOTIFY_CHANNEL, type NotifyMessage } from './types';

const t = setupTestDb(import.meta.url);
let listener: pg.Client;
const received: { at: number; msg: NotifyMessage }[] = [];

beforeAll(async () => {
  listener = new pg.Client({ connectionString: t().appUrl });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel === LOCAL_NOTIFY_CHANNEL && n.payload) {
      received.push({ at: Date.now(), msg: JSON.parse(n.payload) as NotifyMessage });
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
});
