import { describe, expect, test } from 'vitest';
import type { FleetTick, MachineView } from '../../domain/fleet';
import { messageBytes, publish } from './publish';
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

  test('rejects non-object payloads', async () => {
    await expect(publish('admin', 'clock', [] as never, fakeExecutor())).rejects.toThrow(TypeError);
  });
});
