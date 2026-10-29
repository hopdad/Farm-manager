import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { toDrizzleSql } from './exec';
import { cursorOf, jobLeaseSeconds, toClaimedLease } from './leases';

describe('lease helpers (pure)', () => {
  test('jobLeaseSeconds = ceil(budget) + 30', () => {
    expect(jobLeaseSeconds(45_000)).toBe(75);
    expect(jobLeaseSeconds(55_000)).toBe(85);
    expect(jobLeaseSeconds(1_001)).toBe(32);
  });

  test('toClaimedLease maps the snake_case row (Date or Postgres text timestamps)', () => {
    const lease = toClaimedLease({
      source: 'job',
      stream: 'fleet.trucks',
      mode: 'live',
      cursor: 'abc',
      lease_until: '2026-10-29 12:00:30.5+00',
      lease_token: '0f8fad5b-d9cb-469f-a165-70867728950e',
      next_run_at: null,
      last_run_at: new Date('2026-10-29T12:00:00Z'),
      last_ok_at: null,
      last_error: null,
      last_error_at: null,
      extra: null,
    });
    expect(lease.leaseUntil.toISOString()).toBe('2026-10-29T12:00:30.500Z');
    expect(lease.lastRunAt?.toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(lease.extra).toEqual({});
    expect(cursorOf(lease)).toBe('abc');
    expect(cursorOf({ cursor: null })).toBeNull();
    expect(cursorOf({ cursor: { legacy: 1 } })).toBeNull();
  });

  test('toClaimedLease refuses a row without a lease', () => {
    expect(() =>
      toClaimedLease({
        source: 'samsara',
        stream: 'positions',
        mode: 'sim',
        cursor: null,
        lease_until: null,
        lease_token: null,
        next_run_at: null,
        last_run_at: null,
        last_ok_at: null,
        last_error: null,
        last_error_at: null,
        extra: {},
      }),
    ).toThrow(/holds no lease/);
  });
});

describe('toDrizzleSql', () => {
  test('binds $n placeholders as parameters, arrays as one parameter', () => {
    const q = toDrizzleSql('select * from t where a = $1 and b = any($2::text[]) and c = $1', [
      7,
      ['x', 'y'],
    ]);
    const rendered = new PgDialect().sqlToQuery(q);
    expect(rendered.sql).toBe('select * from t where a = $1 and b = any($2::text[]) and c = $3');
    expect(rendered.params).toEqual([7, ['x', 'y'], 7]);
    expect(() => toDrizzleSql('select $2', [1])).toThrow(/no value/);
  });
});
