import { describe, expect, test } from 'vitest';
import {
  assertLocalUrl,
  databaseOf,
  isLoopbackUrl,
  migrationsHash,
  readJournal,
  TEST_DB_PREFIX,
  testDatabaseName,
  withDatabase,
} from './admin';

describe('db admin helpers (no database)', () => {
  test('withDatabase / databaseOf keep credentials and swap the database', () => {
    const url = 'postgres://postgres:p%40ss@127.0.0.1:15432/postgres';
    const other = withDatabase(url, 'farm_dev_map');
    expect(other).toBe('postgres://postgres:p%40ss@127.0.0.1:15432/farm_dev_map');
    expect(databaseOf(other)).toBe('farm_dev_map');
    expect(databaseOf('postgres://u:p@localhost:5432')).toBe('postgres');
  });

  test('only loopback hosts count as local', () => {
    expect(isLoopbackUrl('postgres://u:p@127.0.0.1:15432/postgres')).toBe(true);
    expect(isLoopbackUrl('postgres://u:p@localhost/postgres')).toBe(true);
    expect(isLoopbackUrl('postgres://u:p@[::1]:15432/postgres')).toBe(true);
    expect(isLoopbackUrl('postgres://u:p@aws-0-us-east-2.pooler.supabase.com:5432/postgres')).toBe(
      false,
    );
    expect(() => assertLocalUrl('postgres://u:p@db.example.com/postgres', 'db:reset')).toThrow(
      /db:reset refuses non-local database host 'db.example.com'/,
    );
  });

  test("pg's ?host= / hostaddr overrides are what counts", () => {
    const sneaky = 'postgres://u:p@localhost:15432/postgres?host=db.prod.example.com';
    expect(isLoopbackUrl(sneaky)).toBe(false);
    expect(() => assertLocalUrl(sneaky, 'db:reset')).toThrow(
      /db:reset refuses non-local database host 'db.prod.example.com'/,
    );
    expect(isLoopbackUrl('postgres://u:p@localhost/postgres?hostaddr=10.0.0.5')).toBe(false);
    expect(isLoopbackUrl('postgres://u:p@db.example.com/postgres?host=127.0.0.1')).toBe(true);
    expect(isLoopbackUrl('postgres://u:p@127.0.0.1/postgres?host=localhost&host=evil')).toBe(false);
  });

  test('test database names are unique, prefixed and short enough', () => {
    const a = testDatabaseName('boundaries.db.test.ts');
    const b = testDatabaseName('boundaries.db.test.ts');
    expect(a).toMatch(new RegExp(`^${TEST_DB_PREFIX}boundaries_[0-9a-f]{6}$`));
    expect(a).not.toBe(b);
    expect(testDatabaseName('x'.repeat(200)).length).toBeLessThanOrEqual(63);
    expect(testDatabaseName('Weird Name!.db.test.ts')).toMatch(
      /^farm_test_weird_name_[0-9a-f]{6}$/,
    );
  });

  test('journal lists the migrations in order (M0, then M1) and the hash is stable', () => {
    const journal = readJournal();
    expect(journal.map((e) => e.tag)).toEqual([
      '0000_m0_extensions_roles',
      '0001_m0_tables',
      '0002_m0_functions',
      '0003_m1_see_it',
    ]);
    // drizzle-kit applies a migration only when its `when` is later than the last applied one.
    const whens = journal.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(migrationsHash()).toBe(migrationsHash());
    expect(migrationsHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
