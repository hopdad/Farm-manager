/**
 * Database commands (plan §2/§3). Every subcommand is a pnpm script:
 *
 *   pnpm db:up               docker compose up -d db, wait until healthy, check the password
 *   pnpm db:down             stop and remove the container (data stays in the pgdata volume)
 *   pnpm db:migrate          drizzle-kit migrate with DATABASE_URL_MIGRATE (postgres role)
 *   pnpm db:configure local  farm_app LOGIN + password, pg_cron + pg_net in `postgres`, app.settings defaults
 *   pnpm db:check            M0 spike checks as a PASS/FAIL table (exit 1 on any FAIL)
 *   pnpm db:reset            drop farm, gis, ingest, app, drizzle; migrate; configure; seed demo
 *   pnpm db:nuke             remove the container and its pgdata volume; up + migrate + configure
 *   pnpm db:lint             migrate a brand-new database twice (2nd run must be a no-op), drop it
 *   pnpm db:test-template    (re)create the migrated farm_test_template that DB tests clone
 *   pnpm db:pending          apply db/pending/*.sql (parallel agents' SQL) to the dev database
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { getConfig, getMigrateUrl } from '../src/config';
import {
  APP_SCHEMAS,
  appliedMigrationCount,
  applyPendingSql,
  applySettingsDefaults,
  assertLocalUrl,
  createCronExtensions,
  createDatabase,
  databaseExists,
  databaseOf,
  drizzleKitMigrate,
  dropDatabase,
  dropStaleTestDatabases,
  explainMigrateFailure,
  farmAppCanLogin,
  isLoopbackUrl,
  MIGRATIONS_DIR,
  randomSuffix,
  readJournal,
  refreshTestTemplate,
  schemaFingerprint,
  setFarmAppLogin,
  TEST_TEMPLATE_DB,
  withAdmin,
  withClient,
  withDatabase,
} from '../src/db/admin';
import { runNode, tsxBin } from '../src/lib/proc';
import {
  compose,
  containerHealth,
  DB_SERVICE,
  dbContainerId,
  dockerAvailable,
  projectVolumes,
  removeVolume,
} from './lib/docker';

const log = (msg: string) => console.log(`[db] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
// up / down / nuke
// ---------------------------------------------------------------------------------------------

async function requireDocker(): Promise<void> {
  const d = await dockerAvailable();
  if (!d.ok) {
    throw new Error(
      `Docker is not reachable (${d.why}).\n` +
        'Start Docker Desktop (Settings > General > "Use the WSL 2 based engine") and try again.',
    );
  }
}

function requireEnvFile(): void {
  const cfg = getConfig();
  if (!existsSync(path.join(cfg.projectDir, '.env')) || !cfg.DB_PASSWORD) {
    throw new Error('.env with DB_PASSWORD is missing: run `pnpm env:init` first.');
  }
}

async function waitHealthy(timeoutMs = 300_000): Promise<void> {
  const cfg = getConfig();
  const started = Date.now();
  let lastPrint = 0;
  let status = 'unknown';
  while (Date.now() - started < timeoutMs) {
    const id = await dbContainerId(cfg.projectDir);
    status = id ? await containerHealth(id) : 'missing';
    if (status === 'healthy') break;
    if (status === 'unhealthy' || status === 'exited' || status === 'dead') {
      throw new Error(`database container is ${status}. Logs: docker compose logs ${DB_SERVICE}`);
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (Date.now() - lastPrint > 5000) {
      log(`waiting for the database (${status}, ${secs} s; the first boot takes 1-3 minutes)...`);
      lastPrint = Date.now();
    }
    await sleep(1000);
  }
  if (status !== 'healthy') throw new Error(`database not healthy after ${timeoutMs / 1000} s`);

  // Healthy means pg_isready answers; now prove our password works (the volume keeps the
  // password it was created with, so a regenerated .env doesn't match an old volume).
  const url = getMigrateUrl();
  for (let attempt = 0; ; attempt++) {
    try {
      const version = await withClient(url, async (c) => {
        const r = await c.query(`select current_setting('server_version') as v`);
        return r.rows[0].v as string;
      });
      log(`ready on 127.0.0.1:${cfg.DB_PORT} (PostgreSQL ${version})`);
      return;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === '28P01') {
        throw new Error(
          'The database volume was created with a different postgres password than DB_PASSWORD in .env.\n' +
            'Restore the old .env, or start clean with `pnpm db:nuke` (deletes the local database).',
        );
      }
      if (attempt >= 30) throw err;
      await sleep(1000);
    }
  }
}

async function up(): Promise<void> {
  await requireDocker();
  requireEnvFile();
  const code = await compose(getConfig().projectDir, ['up', '-d', DB_SERVICE]);
  if (code !== 0) throw new Error('docker compose up failed (is port DB_PORT free?)');
  await waitHealthy();
}

async function down(): Promise<void> {
  await requireDocker();
  const code = await compose(getConfig().projectDir, ['down']);
  if (code !== 0) throw new Error('docker compose down failed');
  log('stopped; data kept in the pgdata volume');
}

async function nuke(): Promise<void> {
  assertLocalUrl(getMigrateUrl(), 'db:nuke');
  await requireDocker();
  requireEnvFile();
  const dir = getConfig().projectDir;
  // Remove the container, then only the database volume: gis_work (GIS scratch) survives.
  if ((await compose(dir, ['down'])) !== 0) throw new Error('docker compose down failed');
  for (const v of await projectVolumes('pgdata')) {
    log(`removing volume ${v}`);
    if (!(await removeVolume(v))) throw new Error(`could not remove volume ${v}`);
  }
  await up();
  await migrate();
  await configure('local');
}

// ---------------------------------------------------------------------------------------------
// migrate / configure / reset / pending
// ---------------------------------------------------------------------------------------------

async function migrate(): Promise<void> {
  const url = getMigrateUrl();
  const name = databaseOf(url);
  // A per-agent / per-developer database (farm_dev_<name>) on the local server is created on
  // first migrate, so DATABASE_URL_MIGRATE can simply point at it.
  if (name !== 'postgres' && name.startsWith('farm_') && isLoopbackUrl(url)) {
    await withClient(withDatabase(url, 'postgres'), async (admin) => {
      if (!(await databaseExists(admin, name))) {
        await createDatabase(admin, name);
        log(`created database ${name}`);
      }
    });
  }
  log(`migrating ${name} (${readJournal().length} migrations in ${MIGRATIONS_DIR})`);
  const r = await drizzleKitMigrate(url, { stdio: 'inherit' });
  console.log(); // drizzle-kit's spinner leaves the cursor mid-line
  if (r.code !== 0)
    throw new Error(`drizzle-kit migrate failed: ${await explainMigrateFailure(url)}`);
}

async function configure(target: string | undefined): Promise<void> {
  if (target === 'prod') {
    throw new UsageError(
      'db:configure prod arrives at milestone MD (realtime.messages policies, Vault secrets, cron.schedule).',
    );
  }
  if (target !== 'local') throw new UsageError('usage: pnpm db:configure local');
  const cfg = getConfig();
  assertLocalUrl(getMigrateUrl(), 'db:configure local');
  if (!cfg.FARM_APP_PASSWORD) throw new Error('FARM_APP_PASSWORD missing: run `pnpm env:init`.');
  await withAdmin(async (admin) => {
    await setFarmAppLogin(admin, cfg.FARM_APP_PASSWORD as string);
    log('farm_app: LOGIN, password from .env.local');
    if (databaseOf(getMigrateUrl()) === 'postgres') {
      await createCronExtensions(admin);
      log('pg_cron + pg_net present in the postgres database');
    } else {
      log(
        `pg_cron/pg_net skipped: they live only in the postgres database, not ${databaseOf(getMigrateUrl())}`,
      );
    }
    await applySettingsDefaults(admin);
    log("app.settings defaults present ('clock.paused' = false)");
  });
  const err = await farmAppCanLogin(cfg.DATABASE_URL);
  if (err) throw new Error(`farm_app cannot log in with DATABASE_URL: ${err}`);
  log('farm_app login OK');
}

async function reset(): Promise<void> {
  const cfg = getConfig();
  const url = getMigrateUrl();
  assertLocalUrl(url, 'db:reset');
  assertLocalUrl(cfg.DATABASE_URL, 'db:reset');
  await withAdmin(async (admin) => {
    for (const s of [...APP_SCHEMAS, 'drizzle']) {
      await admin.query(`drop schema if exists ${pg.escapeIdentifier(s)} cascade`);
    }
  });
  log(`dropped schemas ${[...APP_SCHEMAS, 'drizzle'].join(', ')} (the database itself is kept)`);
  await migrate();
  await configure('local');
  const seed = path.join(cfg.projectDir, 'scripts', 'seed.ts');
  if (existsSync(seed)) {
    log('seeding demo (scripts/seed.ts demo)');
    const r = await runNode(tsxBin(), [seed, 'demo'], { cwd: cfg.projectDir, stdio: 'inherit' });
    if (r.code !== 0) throw new Error('seed failed');
  } else {
    log('seeding is not built yet (scripts/seed.ts arrives with the sim/seed stage); schema only');
  }
}

async function pending(): Promise<void> {
  assertLocalUrl(getMigrateUrl(), 'db:pending');
  const files = await withAdmin((admin) => applyPendingSql(admin));
  if (!files.length) log('no db/pending/*.sql files');
  for (const f of files) log(`applied ${path.relative(getConfig().projectDir, f)}`);
}

// ---------------------------------------------------------------------------------------------
// lint / test-template
// ---------------------------------------------------------------------------------------------

/** Functions added after PostGIS 3.3 (guards a fallback image; the pinned image has 3.3.7). */
const POSTGIS_NEWER_THAN_3_3 = [
  'st_coverageunion',
  'st_coveragesimplify',
  'st_coverageinvalidedges',
  'st_coverageclean',
  'st_largestemptycircle',
  'st_clusterintersectingwin',
  'st_clusterwithinwin',
  'st_transformpipeline',
  'st_inversetransformpipeline',
  'st_removeirrelevantpointsforview',
  'st_removesmallparts',
  'st_hasz',
  'st_hasm',
  'st_linesubstring_m',
];

async function lint(): Promise<void> {
  const problems: string[] = [];
  const dir = path.join(getConfig().projectDir, MIGRATIONS_DIR);
  for (const e of readJournal()) {
    const sql = readFileSync(path.join(dir, `${e.tag}.sql`), 'utf8').toLowerCase();
    for (const fn of POSTGIS_NEWER_THAN_3_3) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(sql))
        problems.push(`${e.tag}: uses ${fn} (PostGIS > 3.3)`);
    }
    if (/create\s+extension[^;]*\b(pg_cron|pg_net)\b/.test(sql)) {
      problems.push(`${e.tag}: pg_cron/pg_net belong in db:configure, not migrations`);
    }
    if (/\bpassword\s+'/.test(sql)) problems.push(`${e.tag}: contains a password literal`);
  }

  const name = `farm_lint_${randomSuffix()}`;
  const url = withDatabase(getMigrateUrl(), name);
  await withAdmin((admin) => createDatabase(admin, name));
  log(`created ${name}`);
  try {
    const first = await drizzleKitMigrate(url);
    if (first.code !== 0)
      throw new Error(`first migrate failed: ${await explainMigrateFailure(url)}`);
    const a = await withClient(url, async (c) => ({
      n: await appliedMigrationCount(c),
      fp: await schemaFingerprint(c),
    }));
    log(`run 1: ${a.n} migrations applied`);
    const second = await drizzleKitMigrate(url);
    if (second.code !== 0)
      throw new Error(`second migrate failed:\n${second.stdout}${second.stderr}`);
    const b = await withClient(url, async (c) => ({
      n: await appliedMigrationCount(c),
      fp: await schemaFingerprint(c),
    }));
    log(`run 2: ${b.n} migrations recorded`);
    if (a.n !== readJournal().length)
      problems.push(`expected ${readJournal().length} migrations, got ${a.n}`);
    if (a.n !== b.n) problems.push('second run applied migrations again');
    if (a.fp !== b.fp) problems.push('second run changed the schema');
  } finally {
    await withAdmin((admin) => dropDatabase(admin, name));
    log(`dropped ${name}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[db:lint] FAIL ${p}`);
    throw new Error('db:lint failed');
  }
  log('db:lint PASS: migrations apply from zero, the second run is a no-op, PostGIS <= 3.3');
}

async function testTemplate(): Promise<void> {
  await withAdmin(async (admin) => {
    await refreshTestTemplate(admin, log);
    const dropped = await dropStaleTestDatabases(admin);
    if (dropped.length) log(`dropped ${dropped.length} leftover test database(s)`);
  });
  log(`${TEST_TEMPLATE_DB} is migrated and current`);
}

// ---------------------------------------------------------------------------------------------
// check (M0 spike, plan §6)
// ---------------------------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'WARN';
interface CheckRow {
  check: string;
  status: Status;
  detail: string;
}

async function check(): Promise<void> {
  const rows: CheckRow[] = [];
  const add = (check: string, ok: boolean | 'warn', detail: string) =>
    rows.push({ check, status: ok === 'warn' ? 'WARN' : ok ? 'PASS' : 'FAIL', detail });
  const cfg = getConfig();
  const url = getMigrateUrl();

  try {
    await withClient(url, async (c) => {
      const v = await c.query(
        `select current_setting('server_version') as v, current_user as u, current_database() as d`,
      );
      add(
        'server is PostgreSQL 17',
        String(v.rows[0].v).startsWith('17.'),
        `${v.rows[0].v} as ${v.rows[0].u} in ${v.rows[0].d}`,
      );

      const role = await c.query(
        `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = 'postgres'`,
      );
      const r = role.rows[0] ?? {};
      add(
        'postgres role NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS',
        r.rolsuper === false && r.rolcreatedb && r.rolcreaterole && r.rolbypassrls,
        `super=${r.rolsuper} createdb=${r.rolcreatedb} createrole=${r.rolcreaterole} bypassrls=${r.rolbypassrls}`,
      );

      const sp = await c.query('show search_path');
      const spv = String(sp.rows[0].search_path);
      add('postgres search_path includes extensions', /\bextensions\b/.test(spv), spv);

      const rt = await c.query(
        `select to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null as absent`,
      );
      add(
        'realtime.send absent (local pg_notify path)',
        rt.rows[0].absent === true,
        rt.rows[0].absent ? 'absent' : 'present',
      );

      const priv = await c.query(
        `select current_setting('supautils.privileged_extensions', true) as v`,
      );
      const privList = String(priv.rows[0].v ?? '');
      const needed = ['postgis', 'btree_gist', 'pg_cron', 'pg_net'];
      const missing = needed.filter((x) => !privList.split(/\s*,\s*/).includes(x));
      add(
        'supautils privileged: postgis btree_gist pg_cron pg_net',
        missing.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : 'listed',
      );

      // Creatable in `postgres` (inside a rolled-back transaction: changes nothing).
      for (const [ext, clause] of [
        ['postgis', 'with schema extensions'],
        ['btree_gist', 'with schema extensions'],
        ['pg_cron', ''],
        ['pg_net', 'with schema extensions'],
      ] as const) {
        try {
          await c.query('begin');
          await c.query(`create extension if not exists ${ext} ${clause}`);
          const iv = await c.query(
            `select extversion, extnamespace::regnamespace::text as ns from pg_extension where extname = $1`,
            [ext],
          );
          add(
            `${ext} creatable in postgres`,
            true,
            `${iv.rows[0]?.extversion} in ${iv.rows[0]?.ns}`,
          );
        } catch (e) {
          add(`${ext} creatable in postgres`, false, (e as Error).message);
        } finally {
          await c.query('rollback').catch(() => {});
        }
      }
    });
  } catch (e) {
    add('connect as postgres (DATABASE_URL_MIGRATE)', false, (e as Error).message);
  }

  // A brand-new database: create schema extensions + postgis + btree_gist, versions, EPSG codes.
  const name = `farm_check_${randomSuffix()}`;
  try {
    await withAdmin((admin) => createDatabase(admin, name));
    try {
      await withClient(withDatabase(url, name), async (c) => {
        await c.query('create schema if not exists extensions');
        await c.query('create extension if not exists postgis with schema extensions');
        await c.query('create extension if not exists btree_gist with schema extensions');
        add('postgis + btree_gist creatable in a new database', true, `${name}, schema extensions`);
        const pv = await c.query(
          `select extensions.postgis_lib_version() as postgis, extensions.postgis_geos_version() as geos,
                  extensions.postgis_proj_version() as proj`,
        );
        const p = pv.rows[0];
        add(
          'PostGIS 3.3.x',
          String(p.postgis).startsWith('3.3.'),
          `PostGIS ${p.postgis}, GEOS ${String(p.geos).split('-')[0]}, PROJ ${String(p.proj).split(' ')[0]}`,
        );
        const epsg = await c.query(
          'select array_agg(srid order by srid) as srids from extensions.spatial_ref_sys where srid in (3078, 5070, 3857)',
        );
        const srids = (epsg.rows[0].srids ?? []) as number[];
        add('EPSG 3078, 5070, 3857 present', srids.length === 3, srids.join(', ') || 'none');
      });
    } finally {
      await withAdmin((admin) => dropDatabase(admin, name));
    }
  } catch (e) {
    add('postgis + btree_gist creatable in a new database', false, (e as Error).message);
  }

  // The app role (after db:migrate + db:configure local).
  try {
    await withClient(url, async (c) => {
      const fr = await c.query(
        `select r.rolcanlogin,
                (select array_to_string(s.setconfig, ' ') from pg_db_role_setting s
                  where s.setrole = r.oid and s.setdatabase = 0) as settings
           from pg_roles r where r.rolname = 'farm_app'`,
      );
      if (!fr.rowCount) {
        add('farm_app role (migrations)', 'warn', 'not created yet: run pnpm db:migrate');
        return;
      }
      const settings = String(fr.rows[0].settings ?? '');
      add(
        'farm_app search_path includes extensions',
        /search_path=.*extensions/.test(settings),
        settings || 'no settings',
      );
      if (!fr.rows[0].rolcanlogin) {
        add('farm_app can log in', 'warn', 'NOLOGIN: run pnpm db:configure local');
        return;
      }
      const err = await farmAppCanLogin(cfg.DATABASE_URL);
      add('farm_app can log in (DATABASE_URL)', err === null, err ?? 'ok');
      if (err === null) {
        await withClient(cfg.DATABASE_URL, async (app) => {
          const sp = await app.query(
            `select current_setting('search_path') as sp, extensions.postgis_lib_version() as v`,
          );
          add(
            'farm_app sees PostGIS via search_path',
            true,
            `${sp.rows[0].sp}; postgis ${sp.rows[0].v}`,
          );
        }).catch((e: Error) => add('farm_app sees PostGIS via search_path', false, e.message));
      }
    });
  } catch (e) {
    add('farm_app role', false, (e as Error).message);
  }

  const w = Math.max(...rows.map((r) => r.check.length));
  console.log(`\n${'CHECK'.padEnd(w)}  RESULT  DETAIL`);
  console.log(`${'-'.repeat(w)}  ------  ${'-'.repeat(40)}`);
  for (const r of rows) console.log(`${r.check.padEnd(w)}  ${r.status.padEnd(6)}  ${r.detail}`);
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${failed ? `${failed} FAIL` : 'all PASS'} (${rows.length} checks)`);
  if (failed) {
    console.log('If the image checks fail on this PC, see the fallback in docs/build-plan.md §2.');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------

const commands: Record<string, (args: string[]) => Promise<void>> = {
  up: () => up(),
  down: () => down(),
  migrate: () => migrate(),
  configure: (args) => configure(args[0]),
  check: () => check(),
  reset: () => reset(),
  nuke: () => nuke(),
  lint: () => lint(),
  'test-template': () => testTemplate(),
  pending: () => pending(),
};

async function main(): Promise<void> {
  const [cmd = '', ...args] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) {
    console.error(`usage: tsx scripts/db.ts <${Object.keys(commands).join('|')}>`);
    process.exitCode = 2;
    return;
  }
  try {
    await fn(args);
  } catch (e) {
    console.error(`[db] ${e instanceof UsageError ? '' : 'error: '}${(e as Error).message}`);
    process.exitCode = 1;
  }
}

await main();
