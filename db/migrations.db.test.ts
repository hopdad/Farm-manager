/**
 * Migrations apply from zero, twice, in a brand-new non-`postgres` database (plan §4 rule 7).
 * Uses drizzle-kit migrate, the same command production runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getMigrateUrl } from '../src/config';
import {
  appliedMigrationCount,
  createDatabase,
  drizzleKitMigrate,
  dropDatabase,
  readJournal,
  schemaFingerprint,
  testDatabaseName,
  withAdmin,
  withClient,
  withDatabase,
} from '../src/db/admin';

const name = testDatabaseName('migrations_from_zero');
const url = withDatabase(getMigrateUrl(), name);

beforeAll(async () => {
  await withAdmin((a) => createDatabase(a, name));
});
afterAll(async () => {
  await withAdmin((a) => dropDatabase(a, name));
});

describe('migrations', () => {
  test('apply from zero twice; the second run is a no-op', async () => {
    const first = await drizzleKitMigrate(url);
    expect(first.code).toBe(0);
    const a = await withClient(url, async (c) => ({
      n: await appliedMigrationCount(c),
      fp: await schemaFingerprint(c),
    }));
    expect(a.n).toBe(readJournal().length);

    const second = await drizzleKitMigrate(url);
    expect(second.code).toBe(0);
    const b = await withClient(url, async (c) => ({
      n: await appliedMigrationCount(c),
      fp: await schemaFingerprint(c),
    }));
    expect(b).toEqual(a);
  }, 180_000);

  test('extensions live in schema extensions, never public', async () => {
    const rows = await withClient(url, async (c) => {
      const r = await c.query(
        `select extname, extnamespace::regnamespace::text as ns from pg_extension
          where extname in ('postgis', 'btree_gist') order by extname`,
      );
      return r.rows;
    });
    expect(rows).toEqual([
      { extname: 'btree_gist', ns: 'extensions' },
      { extname: 'postgis', ns: 'extensions' },
    ]);
  });

  test('pg_cron and pg_net are not created by migrations', async () => {
    const n = await withClient(url, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from pg_extension where extname in ('pg_cron', 'pg_net')`,
      );
      return r.rows[0].n as number;
    });
    expect(n).toBe(0);
  });

  test('farm_app is a role with extensions on its search_path', async () => {
    const row = await withClient(url, async (c) => {
      const r = await c.query(
        `select (select array_to_string(setconfig, ' ') from pg_db_role_setting s
                  where s.setrole = r.oid and s.setdatabase = 0) as settings
           from pg_roles r where rolname = 'farm_app'`,
      );
      return r.rows[0];
    });
    expect(row?.settings).toMatch(/search_path=.*extensions/);
  });
});
