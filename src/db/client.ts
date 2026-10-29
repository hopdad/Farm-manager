/**
 * Database access: node-postgres (`pg`) pools + Drizzle. Plan §1 rules:
 *  - The driver is `pg`. postgres.js is banned (pipelining breaks through the Supabase
 *    transaction pooler); Biome's noRestrictedImports enforces it.
 *  - No named prepared statements (`.prepare('name')`): the transaction pooler can't keep them.
 *    Drizzle sends unnamed statements unless you call .prepare(), and src/seams.test.ts bans it.
 *  - The app pool is a globalThis singleton so `next dev` hot reloads don't leak connections.
 *  - Jobs use their own small pool (getJobsPool / createJobsPool) so a sync never starves pages.
 *  - The app connects as `farm_app` (DATABASE_URL); migrations and admin scripts use
 *    DATABASE_URL_MIGRATE (postgres) and never go through this module's singletons.
 */
import { attachDatabasePool } from '@vercel/functions';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** The `tx` argument of `db.transaction(async (tx) => …)`. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a parameterized query: Pool, PoolClient or Client. */
export interface Queryable {
  query: pg.Pool['query'];
}

export interface PoolOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
}

/** A new pg Pool (caller owns its lifecycle). Defaults: DATABASE_URL, DB_POOL_MAX. */
export function createPool(opts: PoolOptions = {}): pg.Pool {
  // Read the app config only for what the caller didn't pass, so tools that bring their own
  // URL and size (bootstrap, tests) work before .env.local exists.
  const cfg = opts.connectionString === undefined || opts.max === undefined ? getConfig() : null;
  const pool = new pg.Pool({
    connectionString: opts.connectionString ?? cfg?.DATABASE_URL,
    max: opts.max ?? cfg?.DB_POOL_MAX,
    application_name: opts.applicationName ?? 'farm-app',
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client erroring (server restart, network blip) must not crash the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/** Drizzle over any pool. */
export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}

/** A new small pool for scheduled jobs (default DB_JOBS_POOL_MAX). */
export function createJobsPool(opts: Omit<PoolOptions, 'applicationName'> = {}): pg.Pool {
  return createPool({
    ...opts,
    max: opts.max ?? getConfig().DB_JOBS_POOL_MAX,
    applicationName: 'farm-jobs',
  });
}

type Singletons = {
  __farmAppPool?: pg.Pool;
  __farmAppDb?: Db;
  __farmJobsPool?: pg.Pool;
  __farmJobsDb?: Db;
};
const g = globalThis as typeof globalThis & Singletons;

/** The app's shared pool (page requests, server actions, route handlers). */
export function getPool(): pg.Pool {
  if (!g.__farmAppPool) {
    g.__farmAppPool = createPool();
    // Vercel: closes idle clients before a function instance is suspended. A no-op locally.
    attachDatabasePool(g.__farmAppPool);
  }
  return g.__farmAppPool;
}

/** Drizzle over the app pool. */
export function getDb(): Db {
  if (!g.__farmAppDb) g.__farmAppDb = createDb(getPool());
  return g.__farmAppDb;
}

/** The shared jobs pool (used by /api/jobs/* and the shop-PC worker). */
export function getJobsPool(): pg.Pool {
  if (!g.__farmJobsPool) {
    g.__farmJobsPool = createJobsPool();
    attachDatabasePool(g.__farmJobsPool);
  }
  return g.__farmJobsPool;
}

/** Drizzle over the jobs pool. */
export function getJobsDb(): Db {
  if (!g.__farmJobsDb) g.__farmJobsDb = createDb(getJobsPool());
  return g.__farmJobsDb;
}

/** Close the singletons (CLI scripts and tests; never needed inside Next). */
export async function closePools(): Promise<void> {
  const pools = [g.__farmAppPool, g.__farmJobsPool].filter((p): p is pg.Pool => !!p);
  g.__farmAppPool = undefined;
  g.__farmAppDb = undefined;
  g.__farmJobsPool = undefined;
  g.__farmJobsDb = undefined;
  await Promise.all(pools.map((p) => p.end()));
}
