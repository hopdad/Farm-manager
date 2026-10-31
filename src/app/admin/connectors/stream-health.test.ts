/** /admin/connectors stream state (1f review): stale against each stream's own schedule. */
import { describe, expect, test } from 'vitest';
import { registry } from '@/jobs/registry';
import { sourceOfConnector, streamCadences, streamHealth } from './stream-health';

const NOW = new Date('2026-11-30T15:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const row = (over: Partial<Parameters<typeof streamHealth>[0]> = {}) => ({
  mode: 'sim',
  nextRunAt: null,
  lastRunAt: ago(1),
  lastOkAt: ago(1),
  lastErrorAt: null,
  ...over,
});

describe('streamHealth', () => {
  test('an hourly paced stream (vehicle lists, Terminal providers) is ok while on schedule', () => {
    // "last run 57 min ago · next in 3 min": before, a warn badge 50 minutes of every hour.
    const hourly = row({ lastRunAt: ago(57), lastOkAt: ago(57), nextRunAt: ago(-3) });
    expect(streamHealth(hourly, NOW, 30)).toEqual({ kind: 'ok', text: 'ok' });
    // Overdue by more than the margin: stale.
    const overdue = row({ lastRunAt: ago(90), lastOkAt: ago(90), nextRunAt: ago(30) });
    expect(streamHealth(overdue, NOW, 30)).toEqual({ kind: 'warn', text: 'stale' });
  });

  test('an unpaced stream: twice its source cadence, never under 10 min', () => {
    // fleet.aemp every 15 min: 20 min since the last OK run is on schedule.
    expect(streamHealth(row({ lastOkAt: ago(20), lastRunAt: ago(20) }), NOW, 900).kind).toBe('ok');
    expect(streamHealth(row({ lastOkAt: ago(31), lastRunAt: ago(31) }), NOW, 900).kind).toBe(
      'warn',
    );
    // A 30 s job: still 10 minutes before "stale".
    expect(streamHealth(row({ lastOkAt: ago(9), lastRunAt: ago(9) }), NOW, 30).kind).toBe('ok');
    expect(streamHealth(row({ lastOkAt: ago(11), lastRunAt: ago(11) }), NOW, 30).kind).toBe('warn');
  });

  test('off, failing and never run as before', () => {
    expect(streamHealth(row({ mode: 'off' }), NOW).text).toBe('off');
    expect(streamHealth(row({ lastErrorAt: ago(0) }), NOW)).toEqual({
      kind: 'bad',
      text: 'failing',
    });
    expect(streamHealth(row({ lastOkAt: null }), NOW).text).toBe('not run yet');
  });

  test('cadences per stream: the job that runs it, not the slowest job of its source', () => {
    const cadenceOf = streamCadences(registry, NOW);
    expect(cadenceOf('aemp', 'faults')).toBe(900);
    expect(cadenceOf('deere', 'fields')).toBe(3600); // deere.fields hourly
    expect(cadenceOf('deere', 'operations')).toBe(900); // deere.ops
    expect(cadenceOf('deere', 'locations')).toBe(120); // fleet.deere, every 2 min
    expect(cadenceOf('samsara', 'vehicles')).toBe(3600); // fleet.vehicles hourly
    expect(cadenceOf('samsara', 'positions')).toBe(30); // fleet.trucks
    expect(cadenceOf('samsara', 'faults')).toBe(30);
    expect(cadenceOf('samsara', 'equipment_stats')).toBe(60); // fleet.equipment
    expect(cadenceOf('nws', 'observations')).toBe(1800);
    // A stream no job declares: the fastest job of its source; no job at all: none.
    expect(cadenceOf('samsara', 'something_new')).toBe(30);
    expect(cadenceOf('nope', 'x')).toBeNull();
    expect(sourceOfConnector('CONNECTOR_WEATHER')).toBe('nws');
  });

  test('a fast stream that stops without an error reads stale after 10 min, not 2 h', () => {
    const cadenceOf = streamCadences(registry, NOW);
    for (const [source, stream] of [
      ['samsara', 'positions'],
      ['samsara', 'faults'],
      ['deere', 'locations'],
    ] as const) {
      const at = (min: number) => row({ lastOkAt: ago(min), lastRunAt: ago(min) });
      expect(streamHealth(at(5), NOW, cadenceOf(source, stream)).kind, stream).toBe('ok');
      expect(streamHealth(at(11), NOW, cadenceOf(source, stream)).kind, stream).toBe('warn');
      expect(streamHealth(at(90), NOW, cadenceOf(source, stream)).kind, stream).toBe('warn');
    }
    // The hourly streams of the same sources stay ok on schedule.
    const hourly = row({ lastOkAt: ago(90), lastRunAt: ago(90) });
    expect(streamHealth(hourly, NOW, cadenceOf('deere', 'fields')).kind).toBe('ok');
    expect(streamHealth(hourly, NOW, cadenceOf('samsara', 'vehicles')).kind).toBe('ok');
  });

  test('every connector job in the registry names the streams it runs, none twice', () => {
    const seen = new Map<string, string>();
    for (const [name, def] of Object.entries(registry)) {
      if (!def?.connector) continue;
      expect(def.streams?.length, name).toBeGreaterThan(0);
      for (const stream of def.streams ?? []) {
        const key = `${sourceOfConnector(def.connector)}/${stream}`;
        expect(seen.get(key), key).toBeUndefined();
        seen.set(key, name);
      }
    }
  });
});
