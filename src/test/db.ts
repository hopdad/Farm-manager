/**
 * DB test harness. Each *.db.test.ts file gets its own database, cloned from the migrated
 * farm_test_template (CREATE DATABASE ... TEMPLATE: fast, no migrations per file) under the
 * server-wide template lock, named `farm_test_<file>_<6 hex>`, and dropped after the file.
 *
 *   import { setupTestDb } from '@/test/db';
 *   const t = setupTestDb(import.meta.url);
 *   test('...', async () => { await t().db.select().from(fields); });
 *
 *  - `pool` / `db` connect as farm_app (what the app runs as: a missing grant fails here).
 *  - `admin` / `adminDb` connect as postgres (setup, inspection, things farm_app may not do).
 *  - db/pending/*.sql (parallel agents' not-yet-migrated SQL) is applied to every clone.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { getConfig, getMigrateUrl } from '../config';
import {
  applyPendingSql,
  cloneTestTemplate,
  dropThrowawayDatabase,
  testDatabaseName,
  withClient,
  withDatabase,
} from '../db/admin';
import { createDb, type Db } from '../db/client';

export interface TestDb {
  /** Database name, e.g. farm_test_boundaries_3fa9c1. */
  name: string;
  /** farm_app URL of this database. */
  appUrl: string;
  /** postgres URL of this database. */
  adminUrl: string;
  /** farm_app pool (max 12). */
  pool: pg.Pool;
  /** Drizzle over `pool` (farm_app). */
  db: Db;
  /** postgres pool (max 4). */
  admin: pg.Pool;
  /** Drizzle over `admin` (postgres). */
  adminDb: Db;
  /** End the pools and drop the database. */
  drop(): Promise<void>;
}

/** Clone the template into a fresh database. `label` is usually the test file name. */
export async function createTestDb(label: string): Promise<TestDb> {
  const cfg = getConfig();
  const name = testDatabaseName(label);
  // Under the server-wide template lock (on the `postgres` maintenance database).
  await cloneTestTemplate(name);
  const adminUrl = withDatabase(getMigrateUrl(), name);
  const appUrl = withDatabase(cfg.DATABASE_URL, name);
  try {
    await withClient(adminUrl, (c) => applyPendingSql(c));
  } catch (e) {
    await dropThrowawayDatabase(name);
    throw e;
  }
  const pool = new pg.Pool({ connectionString: appUrl, max: 12, application_name: 'farm-test' });
  const admin = new pg.Pool({
    connectionString: adminUrl,
    max: 4,
    application_name: 'farm-test-admin',
  });
  pool.on('error', () => {});
  admin.on('error', () => {});
  let dropped = false;
  return {
    name,
    appUrl,
    adminUrl,
    pool,
    db: createDb(pool),
    admin,
    adminDb: createDb(admin),
    async drop() {
      if (dropped) return;
      dropped = true;
      await Promise.allSettled([pool.end(), admin.end()]);
      await dropThrowawayDatabase(name);
    },
  };
}

/**
 * Register beforeAll/afterAll for a per-file database and return a getter.
 * Pass `import.meta.url` (or any label).
 */
export function setupTestDb(fileUrlOrLabel: string): () => TestDb {
  const label = fileUrlOrLabel.startsWith('file:')
    ? (fileURLToPath(fileUrlOrLabel).split(/[\\/]/).pop() ?? 'db')
    : fileUrlOrLabel;
  let current: TestDb | undefined;
  beforeAll(async () => {
    current = await createTestDb(label);
  });
  afterAll(async () => {
    await current?.drop();
  });
  return () => {
    if (!current) throw new Error('test database not ready (use it inside tests or hooks)');
    return current;
  };
}
