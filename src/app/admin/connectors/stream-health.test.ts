/** /admin/connectors stream state (1f review): stale against each stream's own schedule. */
import { describe, expect, test } from 'vitest';
import { registry } from '@/jobs/registry';
import { sourceCadences, sourceOfConnector, streamHealth } from './stream-health';

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

  test('cadences per source from the registry', () => {
    const c = sourceCadences(registry, NOW);
    expect(c.aemp).toBe(900);
    expect(c.deere).toBe(3600); // deere.fields hourly is its slowest job
    expect(c.samsara).toBe(3600); // fleet.vehicles hourly
    expect(sourceOfConnector('CONNECTOR_WEATHER')).toBe('nws');
  });
});
