/**
 * ingest.api_calls_daily and calls per run on a real database, as farm_app (1f decision 4):
 * upserts add up per (source, stream, mode, day), off/bad rows are dropped, one source and
 * mode's streams on a day, both days for the page, and `callsPerRun` merged into
 * sync_state.extra without touching other writers' keys.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { ensureStream } from '../leases';
import {
  apiCallsOn,
  callsPerRunOf,
  recordRunCalls,
  streamCallsOn,
  upsertApiCalls,
} from './api-calls';

const t = setupTestDb(import.meta.url);

const r = (stream: string, mode: 'sim' | 'sandbox', day: string, calls: number, errors = 0) => ({
  source: 'deere',
  stream,
  mode,
  day,
  calls,
  errors,
  rateLimited: 0,
});

describe('upsertApiCalls', () => {
  test('adds to the day row; equal keys merge; empty, off and bad rows are dropped', async () => {
    const p = t().pool;
    expect(
      await upsertApiCalls(p, [
        r('locations', 'sandbox', '2026-10-30', 5, 1),
        r('locations', 'sandbox', '2026-10-30', 2),
        r('fields', 'sandbox', '2026-10-30', 0),
        { ...r('fields', 'sandbox', '2026-10-30', 3), mode: 'off' as never },
        r('fields', 'sandbox', 'yesterday', 3),
      ]),
    ).toBe(1);
    await upsertApiCalls(p, [
      r('locations', 'sandbox', '2026-10-30', 3),
      r('fields', 'sim', '2026-10-30', 9),
    ]);
    await upsertApiCalls(p, [{ ...r('locations', 'sandbox', '2026-10-30', 1), rateLimited: 1 }]);
    expect(await streamCallsOn(p, 'deere', 'sandbox', '2026-10-30')).toEqual({ locations: 11 });
    expect(await streamCallsOn(p, 'deere', 'sim', '2026-10-30')).toEqual({ fields: 9 });
    const rows = await apiCallsOn(p, ['2026-10-30', '2026-10-31']);
    expect(rows.map((x) => [x.stream, x.mode, x.calls, x.errors, x.rateLimited])).toEqual([
      ['locations', 'sandbox', 11, 1, 1],
      ['fields', 'sim', 9, 0, 0],
    ]);
    expect(await upsertApiCalls(p, [])).toBe(0);
  });
});

describe('recordRunCalls', () => {
  test("merged into sync_state.extra; other writers' keys kept; per mode", async () => {
    const p = t().pool;
    await ensureStream(p, 'deere', 'operations', 'sandbox');
    await p.query(
      `update ingest.sync_state set extra = '{"fieldsPerRun": 12, "checked": {"a": "2026"}}'
        where source = 'deere' and stream = 'operations'`,
    );
    expect(await recordRunCalls(p, 'deere', 'operations', 'sandbox', 30)).toBe(30);
    expect(await recordRunCalls(p, 'deere', 'operations', 'sandbox', 40)).toBe(35);
    expect(await callsPerRunOf(p, 'deere', 'operations', 'sandbox')).toBe(35);
    expect(await callsPerRunOf(p, 'deere', 'operations', 'live')).toBeNull();
    const extra = (
      await p.query(
        `select extra from ingest.sync_state where source = 'deere' and stream = 'operations'`,
      )
    ).rows[0].extra;
    expect(extra).toMatchObject({
      fieldsPerRun: 12,
      checked: { a: '2026' },
      callsPerRun: 35,
      callsPerRunMode: 'sandbox',
      callsRecent: [30, 40],
    });
    expect(await recordRunCalls(p, 'deere', 'nothing', 'sim', 3)).toBeNull();
  });
});
