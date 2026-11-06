/**
 * The foundation's part of src/domain/work-jobs.ts (slice 2a; docs/contracts-2a.md §4): the
 * vocabularies, their labels and the usage-event keys. The status machine's exhaustive tests are
 * jobs-api's (src/domain/work-jobs.test.ts).
 */
import { describe, expect, test } from 'vitest';
import {
  ASSIGNMENT_ROLE_LABELS,
  ASSIGNMENT_ROLES,
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  CLOSED_JOB_STATUSES,
  DEFAULT_BUSINESS_LINE,
  isOpenJobStatus,
  JOB_FLAGS,
  JOB_KIND_LABELS,
  JOB_KINDS,
  JOB_PLANNED_UNIT_LABELS,
  JOB_PLANNED_UNITS,
  JOB_PRIORITIES,
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
  JOB_STATUSES,
  OPEN_JOB_STATUSES,
  PERMITTED_USE_LABELS,
  PERMITTED_USES,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_UNIT_LABELS,
  PRODUCT_UNITS,
  RATE_UNIT_LABELS,
  RATE_UNITS,
  REQUEST_CHANNEL_LABELS,
  REQUEST_CHANNELS,
  SUPPLIED_BY,
  SUPPLIED_BY_LABELS,
  USAGE_BUCKET_MINUTES,
  USAGE_HEARTBEAT_MS,
  USAGE_KIND_LABELS,
  USAGE_KINDS,
  usageActorKey,
  usageBucketStart,
} from './work-jobs';

describe('2a vocabularies', () => {
  test('every value has a label, and nothing else does', () => {
    const pairs: [readonly (string | number)[], Record<string | number, string>][] = [
      [JOB_KINDS, JOB_KIND_LABELS],
      [BUSINESS_LINES, BUSINESS_LINE_LABELS],
      [JOB_STATUSES, JOB_STATUS_LABELS],
      [JOB_PRIORITIES, JOB_PRIORITY_LABELS],
      [JOB_PLANNED_UNITS, JOB_PLANNED_UNIT_LABELS],
      [REQUEST_CHANNELS, REQUEST_CHANNEL_LABELS],
      [ASSIGNMENT_ROLES, ASSIGNMENT_ROLE_LABELS],
      [PRODUCT_KINDS, PRODUCT_KIND_LABELS],
      [PRODUCT_UNITS, PRODUCT_UNIT_LABELS],
      [RATE_UNITS, RATE_UNIT_LABELS],
      [SUPPLIED_BY, SUPPLIED_BY_LABELS],
      [PERMITTED_USES, PERMITTED_USE_LABELS],
      [USAGE_KINDS, USAGE_KIND_LABELS],
    ];
    for (const [values, labels] of pairs) {
      expect(Object.keys(labels).sort()).toEqual(values.map(String).sort());
      for (const v of values) expect(labels[v]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_BUSINESS_LINE).sort()).toEqual([...JOB_KINDS].sort());
  });

  test('open and closed statuses split the list; lanes follow the plan', () => {
    expect([...OPEN_JOB_STATUSES, ...CLOSED_JOB_STATUSES].sort()).toEqual([...JOB_STATUSES].sort());
    for (const s of OPEN_JOB_STATUSES) expect(isOpenJobStatus(s)).toBe(true);
    for (const s of CLOSED_JOB_STATUSES) expect(isOpenJobStatus(s)).toBe(false);
    expect(BUSINESS_LINES).toEqual(['spraying', 'grain', 'trucking', 'store']);
    expect(DEFAULT_BUSINESS_LINE.spray).toBe('spraying');
    expect(DEFAULT_BUSINESS_LINE.haul).toBe('trucking');
  });

  test('every value fits the SQL CHECK format (lower-case words)', () => {
    for (const list of [
      JOB_FLAGS,
      JOB_KINDS,
      BUSINESS_LINES,
      JOB_STATUSES,
      JOB_PLANNED_UNITS,
      REQUEST_CHANNELS,
      ASSIGNMENT_ROLES,
      PRODUCT_KINDS,
      PRODUCT_UNITS,
      RATE_UNITS,
      SUPPLIED_BY,
      PERMITTED_USES,
      USAGE_KINDS,
    ]) {
      for (const v of list) expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('usage event keys', () => {
  const DEVICE = '3f2b8c1e-9d4a-5b6c-8e7f-0a1b2c3d4e5f';
  const USER = '7a6b5c4d-3e2f-5a1b-9c8d-7e6f5a4b3c2d';

  test('actor key: device and person, either missing as -', () => {
    expect(usageActorKey(DEVICE, USER)).toBe(`${DEVICE}:${USER}`);
    expect(usageActorKey(null, USER)).toBe(`-:${USER}`);
    expect(usageActorKey(DEVICE, null)).toBe(`${DEVICE}:-`);
    expect(usageActorKey(null, null)).toBe('-:-');
    // The table's CHECK.
    for (const k of [usageActorKey(DEVICE, USER), usageActorKey(null, null)]) {
      expect(k).toMatch(/^([0-9a-f-]{36}|-):([0-9a-f-]{36}|-)$/);
    }
  });

  test(`bucket start: floored to ${USAGE_BUCKET_MINUTES} minutes, never after the event`, () => {
    const at = new Date('2026-11-06T14:07:59.999Z');
    expect(usageBucketStart(at).toISOString()).toBe('2026-11-06T14:05:00.000Z');
    expect(usageBucketStart(new Date('2026-11-06T14:05:00.000Z')).toISOString()).toBe(
      '2026-11-06T14:05:00.000Z',
    );
    expect(usageBucketStart(at).getTime()).toBeLessThanOrEqual(at.getTime());
  });

  test('the heartbeat is shorter than a bucket, so timer drift never skips one', () => {
    expect(USAGE_HEARTBEAT_MS).toBeLessThan(USAGE_BUCKET_MINUTES * 60_000);
    // Drifting late by up to a minute each beat, every 5-minute bucket still gets one.
    let at = Date.parse('2026-11-06T14:00:30Z');
    const buckets = new Set<number>();
    for (let i = 0; i < 300; i++) {
      buckets.add(usageBucketStart(new Date(at)).getTime());
      at += USAGE_HEARTBEAT_MS + 59_000;
    }
    const first = Math.min(...buckets);
    const last = Math.max(...buckets);
    expect(buckets.size).toBe((last - first) / (USAGE_BUCKET_MINUTES * 60_000) + 1);
  });
});
