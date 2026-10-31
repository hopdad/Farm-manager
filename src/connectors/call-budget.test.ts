/**
 * The call counter's glue and fleet.deere's pace (decision 4, docs/contracts-1f.md §5.5): tally
 * rows → api_calls_daily rows under each vendor's mode, the configured mode outside a step, the
 * sink `installCallCounting` installs, and the pace from the shared split (no DB).
 */
import { describe, expect, test } from 'vitest';
import type { Queryable } from '../db/client';
import {
  apiCallRows,
  budgetCountsIn,
  configuredCallMode,
  fleetDeerePace,
  installCallCounting,
  utcDays,
} from './call-budget';
import { locationsShare, paceSeconds } from './deere/call-shares';
import { type CallTallyRow, vendorFetch, withCallStream } from './http';

const row = (vendor: string, stream: string, calls: number): CallTallyRow => ({
  vendor,
  stream,
  day: '2026-10-30',
  calls,
  errors: 1,
  rateLimited: 0,
});

describe('apiCallRows', () => {
  test('each vendor under its mode; vendors without a counted mode are dropped', () => {
    const modes: Record<string, string> = { deere: 'sandbox', samsara: 'sim', motive: 'off' };
    const rows = apiCallRows(
      [
        row('deere', 'record', 3),
        row('samsara', 'record', 2),
        row('motive', 'record', 1),
        row('x', '', 1),
      ],
      (v) => (modes[v] as never) ?? null,
    );
    expect(rows).toEqual([
      {
        source: 'deere',
        stream: 'record',
        mode: 'sandbox',
        day: '2026-10-30',
        calls: 3,
        errors: 1,
        rateLimited: 0,
      },
      {
        source: 'samsara',
        stream: 'record',
        mode: 'sim',
        day: '2026-10-30',
        calls: 2,
        errors: 1,
        rateLimited: 0,
      },
    ]);
  });
});

describe('configuredCallMode', () => {
  test('the vendor names the clients pass, mapped to their mode keys', () => {
    const cfg = {
      CONNECTOR_DEERE: 'live',
      CONNECTOR_SAMSARA: 'replay',
      CONNECTOR_WEATHER: 'sim',
    } as const;
    expect(configuredCallMode(cfg, 'deere')).toBe('live');
    expect(configuredCallMode(cfg, 'samsara')).toBe('replay');
    expect(configuredCallMode(cfg, 'nws')).toBe('sim');
    expect(configuredCallMode(cfg, 'motive')).toBeNull(); // not in this config
    expect(configuredCallMode(cfg, 'qbo')).toBeNull(); // no mode key yet
  });
});

describe('installCallCounting', () => {
  test('withCallStream scopes flush into ingest.api_calls_daily with the configured mode', async () => {
    const statements: { text: string; values: unknown[] }[] = [];
    const ex = {
      query: async (text: string, values: unknown[]) => {
        statements.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Queryable;
    const stop = installCallCounting(ex, (v) => (v === 'deere' ? 'sandbox' : null));
    try {
      await withCallStream('record', async () => {
        await vendorFetch(
          'http://deere.test/platform/organizations',
          {},
          {
            vendor: 'deere',
            fetch: async () => Response.json({}),
            now: () => new Date('2026-10-31T12:00:00Z'),
          },
        );
        await vendorFetch(
          'http://other.test/x',
          {},
          {
            vendor: 'motive',
            fetch: async () => Response.json({}),
          },
        );
      });
    } finally {
      stop();
    }
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toMatch(/insert into ingest\.api_calls_daily/);
    expect(JSON.parse(String(statements[0]?.values[0]))).toEqual([
      { s: 'deere', t: 'record', m: 'sandbox', d: '2026-10-31', c: 1, e: 0, r: 0 },
    ]);
    // Uninstalled: nothing more is written.
    await withCallStream('record', () =>
      vendorFetch(
        'http://deere.test/x',
        {},
        { vendor: 'deere', fetch: async () => Response.json({}) },
      ),
    );
    expect(statements).toHaveLength(1);
  });
});

describe('fleetDeerePace (decision 4)', () => {
  const lastDay = { locations: 3000, fields: 1000, flags: 500, operations: 2000, hours: 300 };

  test('unset budget: limit unknown, no pace', () => {
    const p = fleetDeerePace({ budget: undefined, mode: 'live', lastDay, callsPerRun: 7 });
    expect(p).toMatchObject({ paced: false, minIntervalSeconds: null, budget: null });
    expect(p.reason).toMatch(/limit unknown/);
  });

  test('sim and replay never pace, whatever the budget', () => {
    for (const mode of ['sim', 'replay'] as const) {
      const p = fleetDeerePace({ budget: 10_000, mode, lastDay, callsPerRun: 7 });
      expect(p).toMatchObject({ paced: false, minIntervalSeconds: null, share: null });
      expect(budgetCountsIn(mode)).toBe(false);
    }
  });

  test('nothing measured yet: the share is known, no minimum', () => {
    const p = fleetDeerePace({ budget: 10_000, mode: 'sandbox', lastDay, callsPerRun: null });
    expect(p).toMatchObject({ paced: false, share: 4200, minIntervalSeconds: null });
  });

  test('sandbox/live with a budget and a measured run: the shared split', () => {
    const p = fleetDeerePace({ budget: 10_000, mode: 'live', lastDay, callsPerRun: 7 });
    // 80 % of 10 000 minus the other streams' 3 800 = 4 200 a day; 7 a run → every 144 s.
    expect(p.share).toBe(locationsShare(10_000, lastDay));
    expect(p.share).toBe(4200);
    expect(p.minIntervalSeconds).toBe(paceSeconds(7, 4200));
    expect(p.minIntervalSeconds).toBe(144);
    expect(p.paced).toBe(true);
  });

  test('the other streams over the target: locations at its 10 % floor', () => {
    const p = fleetDeerePace({
      budget: 10_000,
      mode: 'live',
      lastDay: { operations: 9000 },
      callsPerRun: 10,
    });
    expect(p.share).toBe(1000);
    expect(p.minIntervalSeconds).toBe(864);
  });
});

test('utcDays: today and the last full UTC day', () => {
  expect(utcDays(new Date('2026-10-31T00:30:00Z'))).toEqual({
    today: '2026-10-31',
    yesterday: '2026-10-30',
  });
});
