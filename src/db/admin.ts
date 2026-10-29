/**
 * Database administration shared by scripts/db.ts and the DB test harness (src/test/db.ts).
 * Connects as `postgres` (DATABASE_URL_MIGRATE). CLI and tests only; never import from app code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { childEnv, getConfig, getMigrateUrl } from '../config';
import { drizzleKitBin, type RunResult, runNode } from '../lib/proc';

export const MIGRATIONS_DIR = 'db/migrations';
export const PENDING_DIR = 'db/pending';
/** Migrated template cloned by every DB test file (pnpm db:test-template). */
export const TEST_TEMPLATE_DB = 'farm_test_template';
/** Per-file test databases: `farm_test_<label>_<6 hex>`. */
export const TEST_DB_PREFIX = 'farm_test_';
/** Schemas the app owns; db:reset drops these (plus drizzle) and nothing else. */
export const APP_SCHEMAS = ['farm', 'gis', 'ingest', 'app'] as const;

/** app.settings defaults (db:configure; also applied to the test template). */
export const SETTINGS_DEFAULTS: Record<string, unknown> = {
  'clock.paused': false,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ---------------------------------------------------------------------------------------------
// URLs and connections
// ---------------------------------------------------------------------------------------------

/** The same server and credentials, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'postgres';
}

/**
 * Every host pg would connect to for `url`: pg-connection-string lets a `host` query parameter
 * override the URL's host (postgres://…@localhost/db?host=db.prod.example.com connects to the
 * latter), and `hostaddr` is libpq's numeric override; both count.
 */
export function connectionHosts(url: string): string[] {
  const u = new URL(url);
  const host = u.searchParams.getAll('host');
  return [...(host.length ? host : [u.hostname]), ...u.searchParams.getAll('hostaddr')];
}

export function isLoopbackUrl(url: string): boolean {
  return connectionHosts(url).every((h) => LOOPBACK_HOSTS.has(h));
}

/** db:reset, db:seed and sim:* refuse anything but a local database (plan §1). */
export function assertLocalUrl(url: string, what: string): void {
  if (!isLoopbackUrl(url)) {
    const remote = connectionHosts(url).filter((h) => !LOOPBACK_HOSTS.has(h));
    throw new Error(`${what} refuses non-local database host '${remote.join("', '")}'.`);
  }
}

/** Run `fn` with a connected client; always closes it. */
export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'farm-admin' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Run `fn` as postgres on the database DATABASE_URL_MIGRATE names (often `farm_dev_<agent>`). */
export function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(getMigrateUrl(), fn);
}

/**
 * Run `fn` as postgres on the server's `postgres` maintenance database, whatever database
 * DATABASE_URL_MIGRATE names. Server-wide coordination (the template lock) must happen here:
 * advisory locks are per database, so two agents whose URLs name different databases would
 * otherwise not exclude each other.
 */
export function withMaintenance<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(withDatabase(getMigrateUrl(), 'postgres'), fn);
}

const ident = (name: string) => pg.escapeIdentifier(name);

// ---------------------------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------------------------

export async function databaseExists(admin: pg.Client, name: string): Promise<boolean> {
  const r = await admin.query('select 1 from pg_database where datname = $1', [name]);
  return (r.rowCount ?? 0) > 0;
}

/** Advisory lock key shared by every template clone/refresh on this server. */
const TEMPLATE_LOCK_KEY = 0x6661726d; // 'farm'

/**
 * Hold the server-wide template lock while running `fn` with a postgres connection to the
 * `postgres` maintenance database (the lock lives there, so every checkout and every agent
 * shares it, whatever its DATABASE_URL_MIGRATE). Session-level: released when `fn` settles.
 */
export function withTemplateLock<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  return withMaintenance(async (admin) => {
    await admin.query('select pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
    try {
      return await fn(admin);
    } finally {
      await admin.query('select pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]).catch(() => {});
    }
  });
}

export async function createDatabase(
  admin: pg.Client,
  name: string,
  opts: { template?: string } = {},
): Promise<void> {
  const template = opts.template ? ` template ${ident(opts.template)}` : '';
  await admin.query(`create database ${ident(name)}${template}`);
}

export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  await admin.query(`drop database if exists ${ident(name)} with (force)`);
}

/** A short random suffix for throwaway database names. */
export function randomSuffix(bytes = 3): string {
  return randomBytes(bytes).toString('hex');
}

/** `farm_test_<label>_<hex>`, max 63 chars, lower-case [a-z0-9_]. */
export function testDatabaseName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/\.(db\.)?test\.ts$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${TEST_DB_PREFIX}${slug || 'db'}_${randomSuffix()}`;
}

// ---------------------------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------------------------

/** `drizzle-kit migrate` against `url` (the real production path). */
export function drizzleKitMigrate(
  url: string,
  opts: { stdio?: 'inherit' | 'pipe' } = {},
): Promise<RunResult> {
  return runNode(drizzleKitBin(), ['migrate'], {
    cwd: getConfig().projectDir,
    env: childEnv({ DATABASE_URL_MIGRATE: url, FORCE_COLOR: '0' }),
    stdio: opts.stdio ?? 'pipe',
    timeoutMs: 180_000,
  });
}

/**
 * drizzle-kit 0.31 exits 1 without printing why (e.g. a bad password or a failing statement).
 * Re-run the same migrator in-process (drizzle-orm's, which drizzle-kit uses) to get the error.
 * Each migration run is one transaction, so a failed run leaves nothing half-applied.
 */
export async function explainMigrateFailure(url: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'farm-admin' });
  pool.on('error', () => {});
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: path.join(getConfig().projectDir, MIGRATIONS_DIR),
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });
    return 'drizzle-kit failed, but an in-process retry succeeded';
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return [err.message, err.cause?.message].filter(Boolean).join('\n  caused by: ');
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Like drizzleKitMigrate but throws with the underlying error on failure. */
export async function migrateOrThrow(url: string): Promise<void> {
  const r = await drizzleKitMigrate(url);
  if (r.code !== 0) {
    const why = await explainMigrateFailure(url);
    throw new Error(`drizzle-kit migrate failed (${databaseOf(url)}): ${why}`);
  }
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export function readJournal(projectDir = process.cwd()): JournalEntry[] {
  const file = path.join(projectDir, MIGRATIONS_DIR, 'meta', '_journal.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { entries: JournalEntry[] }).entries;
}

/** sha256 over the journal and every migration file: changes whenever migrations change. */
export function migrationsHash(projectDir = process.cwd()): string {
  const h = createHash('sha256');
  for (const e of readJournal(projectDir)) {
    h.update(`${e.idx}:${e.tag}:${e.when}\n`);
    h.update(readFileSync(path.join(projectDir, MIGRATIONS_DIR, `${e.tag}.sql`)));
  }
  return h.digest('hex');
}

/** Rows in drizzle.__drizzle_migrations (0 when the table doesn't exist). */
export async function appliedMigrationCount(client: pg.Client): Promise<number> {
  const exists = await client.query(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as ok`,
  );
  if (!exists.rows[0]?.ok) return 0;
  const r = await client.query('select count(*)::int as n from drizzle.__drizzle_migrations');
  return r.rows[0].n as number;
}

/**
 * A hash of everything migrations create in the app schemas: relations, columns, constraints,
 * indexes, functions (with bodies), triggers, grants and default privileges. Two equal
 * fingerprints = same schema.
 */
export async function schemaFingerprint(client: pg.Client): Promise<string> {
  const schemas = [...APP_SCHEMAS, 'drizzle'];
  const queries = [
    `select n.nspname, c.relname, c.relkind, coalesce(c.relacl::text, '')
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) order by 1, 2`,
    `select table_schema, table_name, column_name, data_type, udt_name, is_nullable,
            coalesce(column_default, '')
       from information_schema.columns where table_schema = any($1) order by 1, 2, 3`,
    `select n.nspname, cl.relname, co.conname, pg_get_constraintdef(co.oid)
       from pg_constraint co join pg_class cl on cl.oid = co.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = any($1) order by 1, 2, 3`,
    `select schemaname, tablename, indexname, indexdef from pg_indexes
      where schemaname = any($1) order by 1, 2, 3`,
    `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc),
            coalesce(p.proacl::text, '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) order by 1, 2, 3`,
    `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid)
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and not t.tgisinternal order by 1, 2, 3`,
    `select coalesce(defaclnamespace::regnamespace::text, ''), defaclobjtype, defaclacl::text
       from pg_default_acl where defaclnamespace = any(
         select oid from pg_namespace where nspname = any($1)) order by 1, 2`,
    `select nspname, coalesce(nspacl::text, '') from pg_namespace where nspname = any($1) order by 1`,
  ];
  const h = createHash('sha256');
  for (const q of queries) {
    const r = await client.query({ text: q, values: [schemas], rowMode: 'array' });
    h.update(JSON.stringify(r.rows));
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Configuration (db:configure local)
// ---------------------------------------------------------------------------------------------

/** Insert app.settings defaults that are missing (never overwrites). */
export async function applySettingsDefaults(client: pg.Client | pg.PoolClient): Promise<void> {
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    await client.query(
      'insert into app.settings (key, value) values ($1, $2::jsonb) on conflict (key) do nothing',
      [key, JSON.stringify(value)],
    );
  }
}

/** Make farm_app a login role with this password (role is cluster-wide). */
export async function setFarmAppLogin(admin: pg.Client, password: string): Promise<void> {
  const role = await admin.query(`select 1 from pg_roles where rolname = 'farm_app'`);
  if (!role.rowCount) {
    throw new Error('Role farm_app does not exist yet: run `pnpm db:migrate` first.');
  }
  // ALTER ROLE takes no bind parameters; escapeLiteral quotes the value safely.
  await admin.query(`alter role farm_app with login password ${admin.escapeLiteral(password)}`);
}

/** Can DATABASE_URL (farm_app) log in? Returns the error message when it can't. */
export async function farmAppCanLogin(url: string): Promise<string | null> {
  try {
    await withClient(url, async (c) => {
      await c.query('select 1');
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Create pg_cron and pg_net in the `postgres` database only (pg_cron can live nowhere else). */
export async function createCronExtensions(admin: pg.Client): Promise<void> {
  if (databaseOf(getMigrateUrl()) !== 'postgres') {
    throw new Error('pg_cron/pg_net belong in the `postgres` database only');
  }
  await admin.query('create extension if not exists pg_cron');
  await admin.query('create extension if not exists pg_net with schema extensions');
}

// ---------------------------------------------------------------------------------------------
// Pending SQL from parallel agents (db/pending/<agent>.sql)
// ---------------------------------------------------------------------------------------------

/** db/pending/*.sql in name order. Each file must be idempotent (create ... if not exists). */
export function pendingSqlFiles(projectDir = process.cwd()): string[] {
  const dir = path.join(projectDir, PENDING_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Apply db/pending/*.sql (each in its own transaction). Returns the files applied. */
export async function applyPendingSql(client: pg.Client): Promise<string[]> {
  const files = pendingSqlFiles();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    await client.query('begin');
    try {
      await client.query(text);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Test template
// ---------------------------------------------------------------------------------------------

const TEMPLATE_COMMENT_PREFIX = 'farm-manager test template; migrations ';
/** Comment stamped on every per-file test database: `<prefix><ISO creation time>`. */
export const TEST_DB_COMMENT_PREFIX = 'farm-manager test db; created ';
/** dropStaleTestDatabases leaves test databases younger than this alone (a file may still be starting). */
export const STALE_TEST_DB_MS = 60 * 60 * 1000;

/** Is farm_test_template present and migrated with the current migrations? */
export async function testTemplateIsCurrent(admin: pg.Client): Promise<boolean> {
  const r = await admin.query(
    `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
    [TEST_TEMPLATE_DB],
  );
  if (!r.rowCount) return false;
  return r.rows[0].comment === `${TEMPLATE_COMMENT_PREFIX}${migrationsHash()}`;
}

export interface RefreshTemplateOptions {
  /** Rebuild even when the template is current. */
  force?: boolean;
  log?: (msg: string) => void;
}

/**
 * Make farm_test_template current: under the server-wide template lock, check its migrations
 * stamp and, if stale or missing (or `force`), drop, create, drizzle-kit migrate, apply settings
 * defaults and stamp it. Concurrent callers (two `pnpm test:db` runs, several agents) rebuild
 * at most once; clones never see a half-built template.
 */
export async function refreshTestTemplate(
  opts: RefreshTemplateOptions = {},
): Promise<'current' | 'rebuilt'> {
  const log = opts.log ?? (() => {});
  return withTemplateLock(async (admin) => {
    if (!opts.force && (await testTemplateIsCurrent(admin))) return 'current';
    log(`dropping ${TEST_TEMPLATE_DB} (if present)`);
    await dropDatabase(admin, TEST_TEMPLATE_DB);
    await createDatabase(admin, TEST_TEMPLATE_DB);
    const url = withDatabase(getMigrateUrl(), TEST_TEMPLATE_DB);
    log('applying migrations with drizzle-kit');
    await migrateOrThrow(url);
    await withClient(url, applySettingsDefaults);
    await admin.query(
      `comment on database ${ident(TEST_TEMPLATE_DB)} is ${admin.escapeLiteral(
        `${TEMPLATE_COMMENT_PREFIX}${migrationsHash()}`,
      )}`,
    );
    return 'rebuilt';
  });
}

/** Stamp a farm_test_* database with its creation time (see dropStaleTestDatabases). */
async function stampTestDatabase(admin: pg.Client, name: string): Promise<void> {
  await admin.query(
    `comment on database ${ident(name)} is ${admin.escapeLiteral(
      `${TEST_DB_COMMENT_PREFIX}${new Date().toISOString()}`,
    )}`,
  );
}

/**
 * Clone farm_test_template into `name` (under the template lock) and stamp the clone with its
 * creation time, so dropStaleTestDatabases never drops a database that is still being set up.
 */
export async function cloneTestTemplate(name: string): Promise<void> {
  await withTemplateLock(async (admin) => {
    if (!(await databaseExists(admin, TEST_TEMPLATE_DB))) {
      throw new Error(`${TEST_TEMPLATE_DB} is missing: run \`pnpm db:test-template\``);
    }
    await createDatabase(admin, name, { template: TEST_TEMPLATE_DB });
    await stampTestDatabase(admin, name);
  });
}

/** An EMPTY stamped test database (e.g. migrations-from-zero tests), via the maintenance DB. */
export async function createEmptyTestDatabase(name: string): Promise<void> {
  await withMaintenance(async (admin) => {
    await createDatabase(admin, name);
    await stampTestDatabase(admin, name);
  });
}

/** Drop a throwaway database via the maintenance DB (never the one DATABASE_URL_MIGRATE names). */
export function dropThrowawayDatabase(name: string): Promise<void> {
  return withMaintenance((admin) => dropDatabase(admin, name));
}

/**
 * Drop leftover per-file test databases (farm_test_*, not the template): nobody connected and
 * created more than STALE_TEST_DB_MS ago (or unstamped). Runs under the template lock.
 */
export async function dropStaleTestDatabases(now: Date = new Date()): Promise<string[]> {
  return withTemplateLock(async (admin) => {
    const r = await admin.query(
      `select d.datname, shobj_description(d.oid, 'pg_database') as comment
         from pg_database d
        where d.datname like $1 and d.datname <> $2
          and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
      [`${TEST_DB_PREFIX.replace(/_/g, '\\_')}%`, TEST_TEMPLATE_DB],
    );
    const dropped: string[] = [];
    for (const row of r.rows as { datname: string; comment: string | null }[]) {
      const created = row.comment?.startsWith(TEST_DB_COMMENT_PREFIX)
        ? Date.parse(row.comment.slice(TEST_DB_COMMENT_PREFIX.length))
        : Number.NaN;
      if (Number.isFinite(created) && now.getTime() - created < STALE_TEST_DB_MS) continue;
      await dropDatabase(admin, row.datname);
      dropped.push(row.datname);
    }
    return dropped;
  });
}
