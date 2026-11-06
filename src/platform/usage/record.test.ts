/**
 * The usage writer without a database (docs/contracts-2a.md §7.7): the row it builds (farm day
 * across midnight and the DST change, the 5-minute bucket, the actor key, the route cut to 200
 * characters) and `recordUsage` never throwing, whatever the executor or the input does.
 * src/db/queries/usage.db.test.ts covers the real insert and its dedupe.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Executor } from '../../db/exec';
import { makeSession } from '../auth/testing';
import {
  MAX_USAGE_ROUTE_CHARS,
  recordUsage,
  UsageInputError,
  usageOf,
  usageRow,
  writeUsage,
} from './record';

const USER = '5b87222b-4b88-5da4-a78b-01f0bfb682c5';
const DEVICE = '84162a8b-6504-52c6-97f2-7ed42b767f99';

afterEach(() => vi.restoreAllMocks());

describe('usageRow', () => {
  test('farm day, bucket and actor key', () => {
    const r = usageRow(
      { kind: 'page_view', route: '/board', appUserId: USER, deviceId: DEVICE },
      new Date('2026-11-06T15:07:31.250Z'),
    );
    expect(r).toEqual({
      at: new Date('2026-11-06T15:07:31.250Z'),
      farmDay: '2026-11-06',
      kind: 'page_view',
      route: '/board',
      appUserId: USER,
      deviceId: DEVICE,
      actorKey: `${DEVICE}:${USER}`,
      bucketAt: new Date('2026-11-06T15:05:00.000Z'),
    });
  });

  test('the farm day is Michigan\'s: the evening is still "today" there; the DST change too', () => {
    const at = (iso: string) =>
      usageRow({ kind: 'job_action', route: '', appUserId: null, deviceId: null }, new Date(iso));
    expect(at('2026-11-07T03:59:00Z').farmDay).toBe('2026-11-06'); // 10:59 PM EST
    expect(at('2026-07-04T03:30:00Z').farmDay).toBe('2026-07-03'); // 11:30 PM EDT
    // Nov 1, 2026: 1:30 AM EDT, then 1:30 AM EST an hour later: the same farm day, two buckets.
    const first = at('2026-11-01T05:30:00Z');
    const second = at('2026-11-01T06:30:00Z');
    expect([first.farmDay, second.farmDay]).toEqual(['2026-11-01', '2026-11-01']);
    expect(first.bucketAt.getTime()).not.toBe(second.bucketAt.getTime());
    expect(at('2026-11-01T03:59:00Z').farmDay).toBe('2026-10-31'); // 11:59 PM EDT
  });

  test('a session with no person or device keys as -:-', () => {
    const r = usageRow(
      usageOf(makeSession({ appUserId: null, deviceId: null }), 'job_action', '/api/v1/jobs'),
      new Date('2026-11-06T15:00:00Z'),
    );
    expect(r.actorKey).toBe('-:-');
    expect(r.bucketAt.toISOString()).toBe('2026-11-06T15:00:00.000Z');
  });

  test('ids are lower-cased; a long route is cut, never refused', () => {
    const r = usageRow(
      {
        kind: 'job_action',
        route: `/api/v1/jobs/${'x'.repeat(300)}`,
        appUserId: USER.toUpperCase(),
        deviceId: null,
      },
      new Date(),
    );
    expect(r.appUserId).toBe(USER);
    expect(r.actorKey).toBe(`-:${USER}`);
    expect(r.route).toHaveLength(MAX_USAGE_ROUTE_CHARS);
  });

  test("a bad kind, id or clock is the caller's bug", () => {
    const base = { kind: 'page_view' as const, route: '/m', appUserId: null, deviceId: null };
    expect(() => usageRow({ ...base, kind: 'nap' as never }, new Date())).toThrow(UsageInputError);
    expect(() => usageRow({ ...base, appUserId: 'amy' }, new Date())).toThrow(UsageInputError);
    expect(() => usageRow({ ...base, deviceId: '42' }, new Date())).toThrow(UsageInputError);
    expect(() => usageRow(base, new Date(Number.NaN))).toThrow(UsageInputError);
  });

  test("usageOf takes the session's person and device", () => {
    const s = makeSession({ appUserId: USER, deviceId: DEVICE, role: 'operator' });
    expect(usageOf(s, 'page_view', '/m')).toEqual({
      kind: 'page_view',
      route: '/m',
      appUserId: USER,
      deviceId: DEVICE,
    });
  });
});

describe('recordUsage never throws', () => {
  const input = { kind: 'page_view' as const, route: '/board', appUserId: USER, deviceId: null };

  test('a database that fails: logged, nothing thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ex: Executor = {
      query: (() => Promise.reject(new Error('connection refused'))) as never,
    };
    await expect(recordUsage(input, { ex })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[1])).toContain('connection refused');
    // writeUsage, for callers that want the failure, does throw.
    await expect(writeUsage(input, { ex })).rejects.toThrow('connection refused');
  });

  test('an executor that throws synchronously, and a bad input', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ex: Executor = {
      query: (() => {
        throw new Error('boom');
      }) as never,
    };
    await expect(recordUsage(input, { ex })).resolves.toBeUndefined();
    await expect(
      recordUsage({ ...input, appUserId: 'not-a-uuid' }, { ex }),
    ).resolves.toBeUndefined();
    await expect(recordUsage(null as never, { ex })).resolves.toBeUndefined();
  });

  test('a written row and a bucket that already had it', async () => {
    const queries: unknown[][] = [];
    let rowCount = 1;
    const ex: Executor = {
      query: ((text: string, values: unknown[]) => {
        queries.push([text, values]);
        return Promise.resolve({ rows: [], rowCount });
      }) as never,
    };
    const now = new Date('2026-11-06T15:07:00Z');
    expect(await writeUsage(input, { ex, now })).toBe(true);
    rowCount = 0;
    expect(await writeUsage(input, { ex, now })).toBe(false);
    expect(String(queries[0]?.[0])).toContain('on conflict (actor_key, kind, route, bucket_at)');
    expect(queries[0]?.[1]).toEqual([
      '2026-11-06T15:07:00.000Z',
      '2026-11-06',
      'page_view',
      '/board',
      USER,
      null,
      `-:${USER}`,
      '2026-11-06T15:05:00.000Z',
    ]);
  });
});
