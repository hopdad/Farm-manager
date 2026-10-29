import { describe, expect, test } from 'vitest';
import type { FleetTick, MachineView } from '../../domain/fleet';
import { messageBytes, notifyText, pgJsonbText, publish } from './publish';
import { MAX_PAYLOAD_BYTES } from './types';

function fakeExecutor() {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query: (async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }) as never,
  };
}

const machine = (i: number): MachineView => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  unitNo: `S${i}`,
  kind: 'semi',
  lng: -84.04,
  lat: 41.9,
  heading: 90,
  speedMph: 50,
  activity: 'transport',
  fieldId: null,
  positionSource: 'eld',
  ts: '2026-10-28T15:00:00.000Z',
  status: 'active',
  stale: false,
});

describe('publish()', () => {
  test('sends one select app.publish with JSON text', async () => {
    const ex = fakeExecutor();
    const tick: FleetTick = { ts: '2026-10-28T15:00:00.000Z', machines: [machine(1)] };
    const r = await publish('fleet', 'tick', tick, ex);
    expect(r.event).toBe('tick');
    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0]?.text).toBe('select app.publish($1, $2, $3::jsonb)');
    expect(ex.calls[0]?.values.slice(0, 2)).toEqual(['fleet', 'tick']);
    expect(JSON.parse(ex.calls[0]?.values[2] as string)).toEqual(tick);
  });

  test('20 machines fit; 60 machines downgrade to invalidate', async () => {
    const small: FleetTick = {
      ts: 'x',
      machines: Array.from({ length: 20 }, (_, i) => machine(i)),
    };
    expect(messageBytes('fleet', 'tick', small)).toBeLessThan(MAX_PAYLOAD_BYTES);
    const ex = fakeExecutor();
    const big: FleetTick = { ts: 'x', machines: Array.from({ length: 60 }, (_, i) => machine(i)) };
    const r = await publish('fleet', 'tick', big, ex);
    expect(r.event).toBe('invalidate');
    expect(ex.calls[0]?.values[1]).toBe('invalidate');
    expect(JSON.parse(ex.calls[0]?.values[2] as string)).toEqual({
      event: 'tick',
      reason: 'too_large',
    });
  });

  test('measures the NOTIFY text Postgres builds, not JSON.stringify', () => {
    // Recorded from the pinned image:
    // select json_build_object('topic','fleet','event','tick','payload',
    //   '{"a":[1,2,{"b":null}],"s":"x\\ny","e":1e-7,"big":1e21,"u":"é"}'::jsonb || jsonb_build_object('seq',5))::text
    const pg =
      '{"topic" : "fleet", "event" : "tick", "payload" : {"a": [1, 2, {"b": null}], "e": 0.0000001, "s": "x\\\\ny", "u": "é", "big": 1000000000000000000000, "seq": 5}}';
    const ours = notifyText(
      'fleet',
      'tick',
      { a: [1, 2, { b: null }], s: 'x\\ny', e: 1e-7, big: 1e21, u: 'é' },
      5,
    );
    expect(Buffer.byteLength(ours)).toBe(Buffer.byteLength(pg));
    expect(pgJsonbText({})).toBe('{}');
    expect(pgJsonbText([])).toBe('[]');
    expect(pgJsonbText({ a: {} })).toBe('{"a": {}}');
    expect(pgJsonbText(1.5e-7)).toBe('0.00000015');
    expect(pgJsonbText(-1.2345e25)).toBe('-12345000000000000000000000');
    expect(pgJsonbText(-0)).toBe('0');
  });

  test('drops undefined like the JSON we send, and budgets a 16-digit seq', () => {
    const withUndef = { paused: true, extra: undefined } as unknown as { paused: boolean };
    expect(notifyText('admin', 'clock', withUndef, 1)).toBe(
      '{"topic" : "admin", "event" : "clock", "payload" : {"paused": true, "seq": 1}}',
    );
    expect(messageBytes('admin', 'clock', { paused: true })).toBe(
      Buffer.byteLength(notifyText('admin', 'clock', { paused: true }, 2 ** 53)),
    );
  });

  test('a tick whose JSON.stringify size is under the limit can still be too large', async () => {
    const tick: FleetTick = { ts: 'x', machines: Array.from({ length: 21 }, (_, i) => machine(i)) };
    let pad = 0;
    // Grow the tick until JSON.stringify says ~7,450 bytes (what the old estimate measured).
    while (
      Buffer.byteLength(
        JSON.stringify({ topic: 'fleet', event: 'tick', payload: { ...tick, seq: 2 ** 53 } }),
      ) < 7_450
    ) {
      pad++;
      tick.ts = 'x'.repeat(pad);
    }
    expect(messageBytes('fleet', 'tick', tick)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const r = await publish('fleet', 'tick', tick, fakeExecutor());
    expect(r.event).toBe('invalidate');
  });

  test('accepts a Drizzle db/tx (anything with execute) as the executor', async () => {
    const executed: unknown[] = [];
    const drizzleLike = {
      execute: async (q: unknown) => {
        executed.push(q);
        return { rows: [], rowCount: 0 };
      },
    };
    const r = await publish('admin', 'clock', { paused: true }, drizzleLike as never);
    expect(r.event).toBe('clock');
    expect(executed).toHaveLength(1);
  });

  test('rejects non-object payloads', async () => {
    await expect(publish('admin', 'clock', [] as never, fakeExecutor())).rejects.toThrow(TypeError);
  });
});
