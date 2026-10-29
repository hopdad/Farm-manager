/**
 * pnpm run bootstrap: one-time PC setup, safe to re-run (plan §2 "Commands", steps 1-7).
 * It only does what's missing, so after `git pull` + `pnpm install` it also applies new
 * migrations. Node/tsx, not a shell script; children run as process.execPath + JS entry points.
 *
 *   1. Checks: Node 24 (with the fix command for your OS), Docker running, ports (Next's and
 *      DB_PORT) free or held by this project, repo folder not under OneDrive.
 *   2. Env files (scripts/env.ts initEnvFiles): .env + .env.local; never regenerates a secret;
 *      stops when a database volume exists but its password is gone.
 *   3. Database: `docker compose up -d db` + wait (scripts/db.ts up), unless already healthy.
 *   4. Migrations (scripts/db.ts migrate) when behind; the DB tests' farm_test_template;
 *      db/pending/*.sql; `db:configure local`; `db:check`.
 *   5. Demo seed: scripts/seed.ts demo (when present; it is idempotent).
 *   6. Offline basemap: tools/gis/basemap.ts when tiles/basemap.json or its file is missing, or
 *      when only the synthetic test basemap is installed (failure stops bootstrap: "offline
 *      basemap missing, run pnpm gis:basemap").
 *   7. Sim connector setup (tools/vendor-sim/connect.ts: Deere sim tokens, ELD token check), then
 *      the URLs, the phone check and the Windows firewall step.
 *
 * Flags:
 *   --dry-run      inspect and print what would be done; changes nothing (passes on a Windows CI
 *                  runner without Docker or env files)
 *   --db=external  use the Postgres in DATABASE_URL_MIGRATE (no Docker for the database)
 *   --no-docker    no Docker at all (implies --db=external; the basemap must then be copied in)
 *   --synthetic-basemap
 *                  accept (or install) the synthetic test basemap instead of a real Protomaps
 *                  extract: CI, and machines that cannot reach build.protomaps.com. The board
 *                  badges it; a later plain bootstrap or `pnpm gis:basemap` replaces it.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { Config, ConfigError } from '../src/config';
import { tryGetConfig } from '../src/config';
import {
  appliedMigrationCount,
  connectionHosts,
  databaseOf,
  farmAppCanLogin,
  isLoopbackUrl,
  pendingSqlFiles,
  readJournal,
  refreshTestTemplate,
  testTemplateIsCurrent,
  withClient,
  withMaintenance,
} from '../src/db/admin';
import { createPool } from '../src/db/client';
import { type PortProbe, probePort, reservedPortHint } from '../src/lib/ports';
import { isMainModule, runNode, tsxBin } from '../src/lib/proc';
import { adminUnlockUrl } from '../src/platform/auth/admin-key';
import { authBannerLines } from '../src/platform/auth/banner';
import { configure, migrate, pending, up } from './db';
import {
  describeReport,
  devOriginCandidates,
  type InitEnvReport,
  initEnvFiles,
  privateIPv4Candidates,
  readEnvFile,
} from './env';
import { containerHealth, dbContainerId, dockerAvailable, projectVolumes } from './lib/docker';

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

export interface BootstrapFlags {
  dryRun: boolean;
  /** 'docker': the compose database; 'external': DATABASE_URL_MIGRATE as configured. */
  db: 'docker' | 'external';
  noDocker: boolean;
  /** Accept / install the synthetic test basemap (CI, no access to build.protomaps.com). */
  syntheticBasemap: boolean;
  help: boolean;
}

export class BootstrapUsageError extends Error {}

export const USAGE =
  'usage: pnpm run bootstrap [--dry-run] [--db=external] [--no-docker] [--synthetic-basemap]';

export function parseBootstrapArgs(argv: string[]): BootstrapFlags {
  const f: BootstrapFlags = {
    dryRun: false,
    db: 'docker',
    noDocker: false,
    syntheticBasemap: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') f.dryRun = true;
    else if (arg === '--synthetic-basemap') f.syntheticBasemap = true;
    else if (arg === '--no-docker') f.noDocker = true;
    else if (arg === '--db=external') f.db = 'external';
    else if (arg === '--db=docker') f.db = 'docker';
    else if (arg === '--help' || arg === '-h') f.help = true;
    else throw new BootstrapUsageError(`unknown argument '${arg}'\n${USAGE}`);
  }
  if (f.noDocker) f.db = 'external';
  return f;
}

// ---------------------------------------------------------------------------------------------
// Checks (pure where possible)
// ---------------------------------------------------------------------------------------------

export type Status = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  /** Shown under a WARN/FAIL: what to do about it. */
  fix?: string;
}

export const REQUIRED_NODE_MAJOR = 24;
/** A Node 24 release published in the winget catalog (checked Oct 29, 2026). */
export const WINGET_NODE_24 = '24.22.1';

/** Node 24 or the exact fix for this OS (Node 26 became LTS, so "install LTS" is wrong). */
export function nodeVersionCheck(version: string, platform: NodeJS.Platform): CheckResult {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (major === REQUIRED_NODE_MAJOR) {
    return { name: 'Node.js 24', status: 'PASS', detail: `v${version.replace(/^v/, '')}` };
  }
  const fix =
    platform === 'win32'
      ? [
          'Install Node 24 (not the "LTS" button: that is Node 26 now). In PowerShell:',
          `  winget install --id OpenJS.NodeJS.LTS --version ${WINGET_NODE_24} --exact --force`,
          '  (if winget refuses because a newer Node is installed: winget uninstall --id OpenJS.NodeJS.LTS,',
          '  then run it again), or download node-v24.x.x-x64.msi from https://nodejs.org/dist/latest-v24.x/',
          '  (nvm-windows users: nvm install 24 ; nvm use 24)',
          'Then open a new PowerShell window, run `npm i -g pnpm@12`, `pnpm install` and bootstrap again.',
        ].join('\n')
      : platform === 'darwin'
        ? 'Install Node 24: `brew install node@24 && brew link --overwrite --force node@24` (or `fnm install 24 && fnm use 24`), then `pnpm install`.'
        : 'Install Node 24: `fnm install 24 && fnm use 24` (or `nvm install 24 && nvm use 24`), then `pnpm install`.';
  return {
    name: 'Node.js 24',
    status: 'FAIL',
    detail: `found v${version.replace(/^v/, '')}; this repo needs ${REQUIRED_NODE_MAJOR}.x (engines.node)`,
    fix,
  };
}

/** The OneDrive folder in `dir`'s path (synced folders lock node_modules and .next), or null. */
export function oneDriveSegment(dir: string): string | null {
  for (const seg of dir.split(/[\\/]+/)) {
    if (/^onedrive(?: - .+)?$/i.test(seg)) return seg;
  }
  return null;
}

export function oneDriveCheck(dir: string): CheckResult {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // keep dir
  }
  const seg = oneDriveSegment(dir) ?? oneDriveSegment(real);
  if (!seg) return { name: 'repo folder not under OneDrive', status: 'PASS', detail: dir };
  return {
    name: 'repo folder not under OneDrive',
    status: 'FAIL',
    detail: `${dir} is inside '${seg}'`,
    fix: 'OneDrive locks node_modules and .next. Clone to C:\\dev\\farm-manager (a Dev Drive is ideal) and run bootstrap there.',
  };
}

/** Rows of `pnpm db:check`'s table: `CHECK  RESULT  DETAIL`. */
export function parseCheckTable(text: string): { check: string; status: Status; detail: string }[] {
  const rows: { check: string; status: Status; detail: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S.*?)\s{2,}(PASS|FAIL|WARN)\s{2,}(.*)$/.exec(line);
    if (m)
      rows.push({ check: (m[1] as string).trim(), status: m[2] as Status, detail: m[3] as string });
  }
  return rows;
}

/** db:check rows that fail by design outside the `postgres` database (pg_cron lives only there). */
export function unexpectedCheckFailures(
  rows: { check: string; status: Status }[],
  database: string,
): string[] {
  return rows
    .filter((r) => r.status === 'FAIL')
    .filter((r) => database === 'postgres' || !/^pg_(cron|net) in postgres$/.test(r.check))
    .map((r) => r.check);
}

/**
 * tiles/basemap.json and the PMTiles file it names (docs/contracts.md §10). The synthetic test
 * basemap (`build` local:synthetic…) counts as missing unless `acceptSynthetic`, so a PC that
 * once ran without access to Protomaps gets the real extract on its next bootstrap.
 */
export function basemapState(
  storageRoot: string,
  opts: { acceptSynthetic?: boolean } = {},
): { ok: boolean; synthetic: boolean; detail: string } {
  const manifest = path.join(storageRoot, 'tiles', 'basemap.json');
  const no = (detail: string, synthetic = false) => ({ ok: false, synthetic, detail });
  if (!existsSync(manifest)) return no('tiles/basemap.json missing');
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { key?: unknown; build?: unknown };
    if (typeof m.key !== 'string' || !m.key) return no('basemap.json has no key');
    if (!existsSync(path.join(storageRoot, 'tiles', m.key))) {
      return no(`basemap.json names ${m.key}, which is missing`);
    }
    const synthetic = typeof m.build === 'string' && m.build.startsWith('local:synthetic');
    if (synthetic && !opts.acceptSynthetic) {
      return no(`only the synthetic test basemap is installed (${m.key})`, true);
    }
    return { ok: true, synthetic, detail: synthetic ? `${m.key} (synthetic test basemap)` : m.key };
  } catch (e) {
    return no(`basemap.json unreadable: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------------------------

export interface BootstrapDeps {
  projectDir: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  out(line: string): void;
  loadConfig(): { ok: true; config: Config } | { ok: false; error: ConfigError };
  dockerAvailable(): Promise<{ ok: true; version: string } | { ok: false; why: string }>;
  /** This project's db container: id ('' if none) and health. */
  dbContainer(projectDir: string): Promise<{ id: string; health: string }>;
  /** Names of this project's pgdata volumes. */
  pgdataVolumes(): Promise<string[]>;
  /** Can a server listen on host:port? (src/lib/ports.ts: connect, then bind.) */
  probePort(port: number, host: string): Promise<PortProbe>;
  /** Does this project's app answer /api/health on that port? */
  isOurApp(port: number): Promise<boolean>;
  /** Does the vendor stand-in answer GET <origin>/_control/status? */
  isStandIn(origin: string): Promise<boolean>;
  /** Run a Node entry point under tsx in the project (stdio inherited). */
  runTsx(entry: string, args: string[]): Promise<number>;
  /** Run `tsx scripts/db.ts check`, capturing its output. */
  runDbCheck(): Promise<{ code: number; output: string }>;
  /** Steps 4a-4e (default: the real ones). Returns false after printing a failure. */
  database?: (a: DbStepArgs) => Promise<boolean>;
  /** Summary lines about signing in, read from the database (default: the real ones). */
  signInLines?: (cfg: Config | null, port: number, dry: boolean) => Promise<string[]>;
}

async function realIsStandIn(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/_control/status`, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as { clock?: unknown };
    return res.ok && typeof body.clock === 'object' && body.clock !== null;
  } catch {
    return false;
  }
}

async function realIsOurApp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await res.json()) as { ok?: unknown; db?: unknown };
    return typeof body.ok === 'boolean' && typeof body.db === 'boolean';
  } catch {
    return false;
  }
}

export function realDeps(projectDir = process.cwd()): BootstrapDeps {
  return {
    projectDir,
    platform: process.platform,
    nodeVersion: process.versions.node,
    out: (line) => console.log(line),
    loadConfig: tryGetConfig,
    dockerAvailable,
    dbContainer: async (dir) => {
      const id = await dbContainerId(dir);
      return { id, health: id ? await containerHealth(id) : 'missing' };
    },
    pgdataVolumes: () => projectVolumes('pgdata'),
    probePort: (port, host) => probePort(port, host),
    isOurApp: realIsOurApp,
    isStandIn: realIsStandIn,
    runTsx: async (entry, args) => {
      const r = await runNode(tsxBin(), [entry, ...args], { cwd: projectDir, stdio: 'inherit' });
      return r.code;
    },
    runDbCheck: async () => {
      const r = await runNode(tsxBin(), [path.join('scripts', 'db.ts'), 'check'], {
        cwd: projectDir,
        timeoutMs: 180_000,
      });
      return { code: r.code, output: `${r.stdout}${r.stderr}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/** Builders bootstrap runs when their entry exists (seed, basemap, sim connect). */
export const SEED_ENTRY = path.join('scripts', 'seed.ts');
export const BASEMAP_ENTRY = path.join('tools', 'gis', 'basemap.ts');
export const SIM_CONNECT_ENTRY = path.join('tools', 'vendor-sim', 'connect.ts');

class StepFailed extends Error {}

const posix = (p: string) => p.split(path.sep).join('/');

export async function bootstrap(flags: BootstrapFlags, d: BootstrapDeps): Promise<number> {
  const dry = flags.dryRun;
  const external = flags.db === 'external';
  const out = d.out;
  const section = (title: string) => out(`\n${title}`);
  const line = (status: Status | 'DONE' | 'TODO' | 'SKIP' | 'RUN', name: string, detail = '') =>
    out(`  ${status.padEnd(4)}  ${name}${detail ? `  ${detail}` : ''}`);
  const showCheck = (c: CheckResult) => {
    line(c.status, c.name, c.detail);
    if (c.fix && c.status !== 'PASS') for (const l of c.fix.split('\n')) out(`          ${l}`);
  };

  out(`Farm Ops bootstrap${dry ? ' (dry run: nothing is changed)' : ''}`);
  out(
    `  project ${d.projectDir}; database ${external ? 'external (DATABASE_URL_MIGRATE)' : 'Docker'}`,
  );

  // 1. Checks that need no configuration.
  section('1. Checks');
  const checks: CheckResult[] = [
    nodeVersionCheck(d.nodeVersion, d.platform),
    oneDriveCheck(d.projectDir),
  ];
  let dockerOk = false;
  if (!external) {
    const dk = await d.dockerAvailable();
    dockerOk = dk.ok;
    checks.push(
      dk.ok
        ? { name: 'Docker running', status: 'PASS', detail: `server ${dk.version}` }
        : {
            name: 'Docker running',
            status: dry ? 'WARN' : 'FAIL',
            detail: dk.why.split('\n')[0] ?? 'not reachable',
            fix: 'Start Docker Desktop (Settings > General > "Use the WSL 2 based engine"), or use --db=external with your own Postgres 17 + PostGIS.',
          },
    );
  }
  for (const c of checks) showCheck(c);
  if (checks.some((c) => c.status === 'FAIL'))
    return fail(out, 'fix the checks above and run bootstrap again');

  // 2. Env files (before anything reads the config: it is loaded once per process).
  section('2. Env files');
  const envFile = path.join(d.projectDir, '.env');
  const localValues = readEnvFile(path.join(d.projectDir, '.env.local')).values;
  if (!external && dockerOk && !existsSync(envFile) && !localValues.DATABASE_URL_MIGRATE) {
    const vols = await d.pgdataVolumes();
    if (vols.length) {
      line(
        'FAIL',
        '.env',
        `missing, but the database volume ${vols[0]} exists with its old password`,
      );
      out('          Restore your old .env, or start clean (deletes the local database):');
      out('          pnpm env:init, then pnpm db:nuke, then pnpm run bootstrap');
      return fail(out, 'database password unknown');
    }
  }
  let report: InitEnvReport;
  try {
    report = initEnvFiles(d.projectDir, { dryRun: dry });
  } catch (e) {
    return fail(out, `could not write the env files: ${(e as Error).message}`);
  }
  const added = [...report.added.env, ...report.added.envLocal];
  line(
    added.length || report.updated.length ? (dry ? 'TODO' : 'DONE') : 'DONE',
    '.env + .env.local',
    added.length || report.updated.length
      ? `${dry ? 'would add' : 'added'} ${[...added, ...report.updated].join(', ')}`
      : 'present, nothing to add',
  );
  for (const l of describeReport(report).split('\n')) {
    if (l.startsWith('warning:')) out(`          ${l}`);
  }
  if (external && report.added.envLocal.includes('DATABASE_URL_MIGRATE')) {
    out(
      '          --db=external: point DATABASE_URL and DATABASE_URL_MIGRATE in .env.local at your',
    );
    out('          Postgres (database `postgres`), then run bootstrap again.');
  }

  const loaded = d.loadConfig();
  const cfg = loaded.ok ? loaded.config : null;
  if (!cfg && !dry) {
    return fail(
      out,
      `configuration invalid after writing the env files:\n${loaded.ok ? '' : loaded.error.message}`,
    );
  }
  const dbPort = cfg?.DB_PORT ?? Number(report.env.DB_PORT ?? 15432);
  const publicUrl = cfg?.PUBLIC_URL ?? report.envLocal.PUBLIC_URL ?? 'http://localhost:3000';
  const appPort = Number(new URL(publicUrl).port) || 3000;

  // 3. Ports (they come from the env files).
  section('3. Ports');
  let container = { id: '', health: 'missing' };
  if (!external && dockerOk) container = await d.dbContainer(d.projectDir);
  const ourDbUp =
    container.id !== '' && ['healthy', 'starting', 'running'].includes(container.health);
  const portChecks: CheckResult[] = [];
  /** A port the server can't bind for another reason than "in use". */
  const cannotListen = (name: string, port: number, p: PortProbe, setting: string): CheckResult =>
    p.state === 'reserved'
      ? {
          name,
          status: 'FAIL',
          detail:
            d.platform === 'win32'
              ? 'reserved by Windows (excluded port range)'
              : 'cannot listen (EACCES)',
          fix: `${reservedPortHint(port, setting, d.platform)}.`,
        }
      : {
          name,
          status: 'FAIL',
          detail: `cannot listen (${p.code ?? 'error'})`,
          fix: `Pick another port (${setting}).`,
        };
  // Next listens on every address (phones on the LAN reach it), so check it that way.
  const appName = `port ${appPort} (Next)`;
  const app = await d.probePort(appPort, '0.0.0.0');
  if (app.state === 'in_use') {
    portChecks.push(
      (await d.isOurApp(appPort))
        ? {
            name: appName,
            status: 'PASS',
            detail: "in use by this project's app (pnpm dev running)",
          }
        : {
            name: appName,
            status: 'FAIL',
            detail: 'in use by another program',
            fix: `Close it, or set PUBLIC_URL=http://localhost:<free port> in .env.local.`,
          },
    );
  } else if (app.state === 'free')
    portChecks.push({ name: appName, status: 'PASS', detail: 'free' });
  else portChecks.push(cannotListen(appName, appPort, app, 'PUBLIC_URL in .env.local'));
  if (!external) {
    // Docker publishes the database on 127.0.0.1 only.
    const dbName = `port ${dbPort} (DB_PORT)`;
    const db = await d.probePort(dbPort, '127.0.0.1');
    if (db.state === 'in_use') {
      portChecks.push(
        ourDbUp
          ? { name: dbName, status: 'PASS', detail: "held by this project's database container" }
          : {
              name: dbName,
              status: 'FAIL',
              detail: 'in use by another program (another Postgres?)',
              fix: 'Stop it, or set DB_PORT in .env (and the port in both database URLs in .env.local).',
            },
      );
    } else if (db.state === 'free')
      portChecks.push({ name: dbName, status: 'PASS', detail: 'free' });
    else {
      portChecks.push(
        cannotListen(dbName, dbPort, db, 'DB_PORT in .env and both database URLs in .env.local'),
      );
    }
  }
  // The vendor stand-in (loopback only).
  const simUrl = new URL(
    cfg?.VENDOR_SIM_URL ?? report.envLocal.VENDOR_SIM_URL ?? 'http://127.0.0.1:4010',
  );
  const simPort = Number(simUrl.port) || 80;
  const simHost =
    simUrl.hostname === 'localhost' ? '127.0.0.1' : simUrl.hostname.replace(/^\[|\]$/g, '');
  const simName = `port ${simPort} (vendor stand-in)`;
  const sim = await d.probePort(simPort, simHost);
  if (sim.state === 'in_use') {
    portChecks.push(
      (await d.isStandIn(simUrl.origin))
        ? {
            name: simName,
            status: 'PASS',
            detail: 'in use by the vendor stand-in (pnpm dev running)',
          }
        : {
            name: simName,
            status: 'FAIL',
            detail: 'in use by another program',
            fix: 'Close it, or set VENDOR_SIM_URL=http://127.0.0.1:<free port> in .env.local.',
          },
    );
  } else if (sim.state === 'free')
    portChecks.push({ name: simName, status: 'PASS', detail: 'free' });
  else portChecks.push(cannotListen(simName, simPort, sim, 'VENDOR_SIM_URL in .env.local'));
  for (const c of portChecks) showCheck(c);
  if (portChecks.some((c) => c.status === 'FAIL'))
    return fail(out, 'free the ports above and run bootstrap again');

  // 4. Database.
  section('4. Database');
  if (!cfg) {
    line(
      'TODO',
      'database',
      external
        ? 'would connect to DATABASE_URL_MIGRATE'
        : 'would start it (docker compose up -d db) and wait',
    );
    line(
      'TODO',
      'migrations, test template, db/pending, db:configure local, db:check',
      'would run once the env files exist',
    );
  } else {
    const steps = await (d.database ?? databaseSteps)({
      dry,
      external,
      dockerOk,
      container,
      cfg,
      d,
      line,
      out,
    });
    if (!steps) return fail(out, 'database setup failed (see above)');
  }

  // 5-7. Optional builders owned by other stages.
  section('5. Demo data, offline basemap, sim connectors');
  const has = (entry: string) => existsSync(path.join(d.projectDir, entry));
  try {
    if (!has(SEED_ENTRY)) {
      line('SKIP', 'demo seed', `${posix(SEED_ENTRY)} missing from this checkout`);
    } else if (dry || !cfg) {
      line('TODO', 'demo seed', `would run ${posix(SEED_ENTRY)} demo (idempotent)`);
    } else {
      line('RUN', 'demo seed', `${posix(SEED_ENTRY)} demo`);
      const code = await d.runTsx(SEED_ENTRY, ['demo']);
      if (code !== 0)
        throw new StepFailed(
          `the demo seed failed (exit ${code}); run \`pnpm db:seed demo\` to see why`,
        );
      line('DONE', 'demo seed');
    }

    const storageRoot = path.resolve(d.projectDir, cfg?.STORAGE_DIR ?? '.data/storage');
    const acceptSynthetic = flags.syntheticBasemap;
    const bm = basemapState(storageRoot, { acceptSynthetic });
    const basemapArgs = flags.syntheticBasemap ? ['--synthetic'] : [];
    const basemapCmd = [posix(BASEMAP_ENTRY), ...basemapArgs].join(' ');
    if (bm.ok) {
      line('DONE', 'offline basemap', bm.detail);
    } else if (!has(BASEMAP_ENTRY)) {
      line(
        'SKIP',
        'offline basemap',
        `${bm.detail}; ${posix(BASEMAP_ENTRY)} missing from this checkout`,
      );
    } else if (dry) {
      line('TODO', 'offline basemap', `${bm.detail}: would run ${basemapCmd}`);
    } else if (flags.noDocker) {
      // pmtiles extract runs in protomaps/go-pmtiles (Docker); a native go-pmtiles download for
      // --no-docker is not built yet.
      throw new StepFailed(
        'offline basemap missing: `pnpm gis:basemap` needs Docker (protomaps/go-pmtiles). ' +
          'Run it on a machine with Docker and copy .data/storage/tiles here.',
      );
    } else {
      line('RUN', 'offline basemap', `${bm.detail}: ${basemapCmd}`);
      const code = await d.runTsx(BASEMAP_ENTRY, basemapArgs);
      const after = basemapState(storageRoot, { acceptSynthetic });
      if (code !== 0 || !after.ok) {
        throw new StepFailed(
          'offline basemap missing, run `pnpm gis:basemap`' +
            (bm.synthetic || after.synthetic
              ? ' (or keep the synthetic test basemap: pnpm run bootstrap --synthetic-basemap)'
              : ''),
        );
      }
      line('DONE', 'offline basemap', after.detail);
    }

    if (!has(SIM_CONNECT_ENTRY)) {
      line(
        'SKIP',
        'sim connector tokens',
        `${posix(SIM_CONNECT_ENTRY)} missing from this checkout`,
      );
    } else if (dry || !cfg) {
      line('TODO', 'sim connector tokens', `would run ${posix(SIM_CONNECT_ENTRY)}`);
    } else {
      line('RUN', 'sim connector tokens', posix(SIM_CONNECT_ENTRY));
      const code = await d.runTsx(SIM_CONNECT_ENTRY, []);
      if (code !== 0) throw new StepFailed(`${posix(SIM_CONNECT_ENTRY)} failed (exit ${code})`);
      line('DONE', 'sim connector tokens');
    }
  } catch (e) {
    if (e instanceof StepFailed) return fail(out, e.message);
    throw e;
  }

  // Summary.
  section(dry ? 'Dry run complete: nothing was changed.' : 'Ready.');
  for (const l of await summary(appPort, cfg, d.platform, dry, d.signInLines ?? signInLines)) {
    out(l);
  }
  return 0;
}

export interface DbStepArgs {
  dry: boolean;
  external: boolean;
  dockerOk: boolean;
  container: { id: string; health: string };
  cfg: Config;
  d: BootstrapDeps;
  line: (status: Status | 'DONE' | 'TODO' | 'SKIP' | 'RUN', name: string, detail?: string) => void;
  out: (l: string) => void;
}

async function canConnect(
  url: string,
): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  try {
    await withClient(url, async (c) => {
      await c.query('select 1');
    });
    return { ok: true };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, code: err.code, message: err.message };
  }
}

/** Steps 3-4. Returns false after printing a failure. */
async function databaseSteps(a: DbStepArgs): Promise<boolean> {
  const { dry, cfg, line, out } = a;
  const migrateUrl = cfg.DATABASE_URL_MIGRATE;
  if (!migrateUrl) {
    line('FAIL', 'DATABASE_URL_MIGRATE', 'missing from .env.local');
    return false;
  }
  if (!isLoopbackUrl(migrateUrl)) {
    // Before connecting: migrations, the test template and db:configure are for a local server.
    line(
      'FAIL',
      'database',
      `bootstrap only sets up a local database; DATABASE_URL_MIGRATE points at ${connectionHosts(migrateUrl).join(', ')}`,
    );
    return false;
  }
  const dbName = databaseOf(migrateUrl);

  // 3. The server.
  let reach = await canConnect(migrateUrl);
  if (reach.ok) {
    line('DONE', 'database', `reachable (${dbName} on ${new URL(migrateUrl).host})`);
  } else if (reach.code === '28P01') {
    line('FAIL', 'database', 'the postgres password in .env does not match the database volume');
    out(
      '          Restore your old .env, or start clean with `pnpm db:nuke` (deletes the local database).',
    );
    return false;
  } else if (a.external) {
    line(dry ? 'WARN' : 'FAIL', 'database', `not reachable: ${reach.message}`);
    out(
      '          --db=external: start your Postgres 17 + PostGIS and check DATABASE_URL_MIGRATE.',
    );
    if (dry) {
      line(
        'TODO',
        'migrations, test template, db/pending, db:configure local, db:check',
        'would run once it is reachable',
      );
      return true;
    }
    return false;
  } else if (dry) {
    line(
      'TODO',
      'database',
      `would run docker compose up -d db and wait (container ${a.container.health})`,
    );
    line(
      'TODO',
      'migrations, test template, db/pending, db:configure local, db:check',
      'would run once it is up',
    );
    return true;
  } else {
    line('RUN', 'database', 'docker compose up -d db (the first boot takes 1-3 minutes)');
    try {
      await up();
    } catch (e) {
      line('FAIL', 'database', (e as Error).message);
      return false;
    }
    reach = await canConnect(migrateUrl);
    if (!reach.ok) {
      line('FAIL', 'database', reach.message);
      return false;
    }
    line('DONE', 'database', 'up');
  }

  // 4a. Migrations.
  const journal = readJournal(cfg.projectDir).length;
  let applied = 0;
  try {
    applied = await withClient(migrateUrl, appliedMigrationCount);
  } catch {
    applied = 0;
  }
  if (applied >= journal) {
    line('DONE', 'migrations', `${applied} of ${journal} applied (${dbName})`);
  } else if (dry) {
    line('TODO', 'migrations', `${applied} of ${journal} applied: would migrate ${dbName}`);
  } else {
    line('RUN', 'migrations', `${applied} of ${journal} applied: migrating ${dbName}`);
    try {
      await migrate();
    } catch (e) {
      line('FAIL', 'migrations', (e as Error).message);
      return false;
    }
    line('DONE', 'migrations', `${journal} of ${journal} applied`);
  }

  // 4b. The DB tests' template (clone source for every *.db.test.ts file).
  try {
    const current = await withMaintenance(testTemplateIsCurrent);
    if (current) line('DONE', 'farm_test_template', 'current');
    else if (dry) line('TODO', 'farm_test_template', 'would rebuild it for the current migrations');
    else {
      line('RUN', 'farm_test_template', 'rebuilding for the current migrations');
      await refreshTestTemplate();
      line('DONE', 'farm_test_template', 'current');
    }
  } catch (e) {
    line('WARN', 'farm_test_template', `${(e as Error).message} (pnpm test:db rebuilds it)`);
  }

  // 4c. db/pending/*.sql (parallel stages' SQL that isn't a migration yet; idempotent).
  const pendingFiles = pendingSqlFiles(cfg.projectDir);
  if (!pendingFiles.length) line('DONE', 'db/pending', 'no files');
  else if (dry)
    line(
      'TODO',
      'db/pending',
      `would apply ${pendingFiles.map((f) => path.basename(f)).join(', ')}`,
    );
  else {
    try {
      await pending();
      line('DONE', 'db/pending', `applied ${pendingFiles.map((f) => path.basename(f)).join(', ')}`);
    } catch (e) {
      line('FAIL', 'db/pending', (e as Error).message);
      return false;
    }
  }

  // 4d. db:configure local (farm_app login, pg_cron/pg_net in postgres, app.settings defaults).
  const configured = await isConfigured(cfg, migrateUrl);
  if (configured === true) line('DONE', 'db:configure local', 'farm_app logs in; settings present');
  else if (dry) line('TODO', 'db:configure local', `would run (${configured})`);
  else {
    try {
      await configure('local');
    } catch (e) {
      line('FAIL', 'db:configure local', (e as Error).message);
      return false;
    }
    line('DONE', 'db:configure local');
  }

  // 4e. db:check (the M0 spike checks).
  if (dry) {
    line('TODO', 'db:check', 'would run the database checks');
    return true;
  }
  const chk = await a.d.runDbCheck();
  const rows = parseCheckTable(chk.output);
  const bad = unexpectedCheckFailures(rows, dbName);
  if (!rows.length) {
    out(chk.output.trim().replace(/^/gm, '          '));
    line('FAIL', 'db:check', `no result table (exit ${chk.code})`);
    return false;
  }
  if (bad.length) {
    out(chk.output.trim().replace(/^/gm, '          '));
    line('FAIL', 'db:check', `failed: ${bad.join('; ')}`);
    out(
      '          If the image checks fail on this PC, see the fallback in docs/build-plan.md §2.',
    );
    return false;
  }
  const expected = rows.filter((r) => r.status === 'FAIL').length;
  line(
    'DONE',
    'db:check',
    `${rows.length - expected} of ${rows.length} PASS${expected ? ` (${expected} pg_cron/pg_net row(s) only pass in the postgres database)` : ''}`,
  );
  return true;
}

/** true, or why `db:configure local` still needs to run. */
async function isConfigured(cfg: Config, migrateUrl: string): Promise<true | string> {
  const loginErr = await farmAppCanLogin(cfg.DATABASE_URL);
  if (loginErr) return 'farm_app cannot log in yet';
  try {
    return await withClient(migrateUrl, async (c: pg.Client) => {
      const s = await c.query(`select 1 from app.settings where key = 'clock.paused'`);
      if (!s.rowCount) return 'app.settings defaults missing';
      if (databaseOf(migrateUrl) === 'postgres') {
        const ext = await c.query(
          `select count(*)::int as n from pg_extension where extname in ('pg_cron', 'pg_net')`,
        );
        if ((ext.rows[0]?.n ?? 0) < 2) return 'pg_cron/pg_net missing';
      }
      return true as const;
    });
  } catch (e) {
    return (e as Error).message;
  }
}

const GENERIC_SIGN_IN_LINES = [
  '  Sign-in:            `pnpm dev` prints the first-run owner link, then where to sign in and',
  '                      the demo PINs (docs/kiosk.md: the wall kiosk and cab iPads)',
];

/**
 * Sign-in lines from the database (owner setup link, devices, demo PINs). On a dry run, or if
 * the database can't answer, the generic pointer to `pnpm dev`: the summary never fails a run.
 */
async function signInLines(cfg: Config | null, port: number, dry: boolean): Promise<string[]> {
  if (!cfg || dry) return GENERIC_SIGN_IN_LINES;
  const pool = createPool({
    connectionString: cfg.DATABASE_URL,
    max: 1,
    applicationName: 'farm-bootstrap',
  });
  try {
    return await authBannerLines(pool, cfg.SESSION_SECRET, `http://localhost:${port}`);
  } catch {
    return GENERIC_SIGN_IN_LINES;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function summary(
  port: number,
  cfg: Config | null,
  platform: NodeJS.Platform,
  dry: boolean,
  readSignInLines: NonNullable<BootstrapDeps['signInLines']>,
): Promise<string[]> {
  const origins = cfg?.DEV_ORIGINS.length ? cfg.DEV_ORIGINS : devOriginCandidates();
  const adapters = new Map(privateIPv4Candidates().map((c) => [c.address, c.iface]));
  const lines = [
    '  Start everything:   pnpm dev        (app + clock + vendor stand-in; Ctrl+C stops all)',
    `  Board:              http://localhost:${port}/board`,
    ...(await readSignInLines(cfg, port, dry)),
    `  Sync health:        http://localhost:${port}/admin/connectors   (clock + simulation controls)`,
    cfg
      ? `  Admin on this PC:   ${adminUnlockUrl(`http://localhost:${port}`, cfg.SESSION_SECRET)}`
      : '  Admin on this PC:   open the Admin link `pnpm dev` prints (on this PC)',
    '  Phones on the same Wi-Fi (pick the adapter of your shop network):',
    ...origins.map(
      (o) => `    http://${o}:${port}/m${adapters.has(o) ? `   (${adapters.get(o)})` : ''}`,
    ),
    `  Phone check:        open http://<pc-ip>:${port}/api/health on the phone; it should show "ok":true`,
    `  Demo:               scenario ${cfg?.SIM_SCENARIO ?? 'harvest-day'}; \`pnpm dev --scenario=spray-windy --speed=30\` runs a farm day in ~30 min.`,
    '  Your data:          pnpm gis:soils (real SSURGO, once, needs internet), pnpm import:boundaries',
    '                      <Ops Center export>, pnpm import:seasons <csv>: see README "Your own data".',
    `  ${platform === 'win32' ? 'Windows firewall' : 'Firewall (Windows PC)'}: set the shop Wi-Fi profile to Private and allow Node.js on private networks`,
    '    when prompted, or once in an admin PowerShell:',
    `    New-NetFirewallRule -DisplayName 'farm-ops dev' -Direction Inbound -Protocol TCP -LocalPort ${port},3443 -Profile Private -Action Allow`,
    '    If you dismissed the Windows prompt, it created Block rules for Node.js that beat any Allow',
    '    rule; remove them first (admin PowerShell):',
    "    Get-NetFirewallRule | Where-Object { $_.Name -like '*Query User*' -and $_.Name -like '*node.exe*' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule",
  ];
  return lines;
}

function fail(out: (l: string) => void, why: string): number {
  out(`\nbootstrap stopped: ${why}`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  let flags: BootstrapFlags;
  try {
    flags = parseBootstrapArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  return bootstrap(flags, realDeps());
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: Error) => {
      console.error(`bootstrap failed: ${e.stack ?? e.message}`);
      process.exitCode = 1;
    },
  );
}
