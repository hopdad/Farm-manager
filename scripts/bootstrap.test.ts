/**
 * Bootstrap: the pure checks, and whole runs with injected dependencies, including the
 * `--dry-run` of a Windows CI runner (no Docker, no env files) that must pass and change nothing.
 * One real `tsx scripts/bootstrap.ts --dry-run --no-docker` run checks the CLI end to end.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ConfigError, parseConfig } from '../src/config';
import { runNode, tsxBin } from '../src/lib/proc';
import {
  type BootstrapDeps,
  basemapState,
  bootstrap,
  nodeVersionCheck,
  oneDriveSegment,
  parseBootstrapArgs,
  parseCheckTable,
  unexpectedCheckFailures,
} from './bootstrap';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'farm-boot-'));

function fakeDeps(
  over: Partial<BootstrapDeps> & { projectDir: string },
): BootstrapDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    platform: 'win32',
    nodeVersion: '24.22.2',
    out: (l) => lines.push(l),
    loadConfig: () => ({ ok: false, error: new ConfigError(['DATABASE_URL: Required']) }),
    dockerAvailable: async () => ({
      ok: false,
      why: 'error during connect: open //./pipe/docker_engine',
    }),
    dbContainer: async () => ({ id: '', health: 'missing' }),
    pgdataVolumes: async () => [],
    probePort: async () => ({ state: 'free' }),
    isOurApp: async () => false,
    isStandIn: async () => false,
    runTsx: async () => {
      throw new Error('nothing may run in this test');
    },
    runDbCheck: async () => {
      throw new Error('nothing may run in this test');
    },
    ...over,
  };
}

const DRY = {
  dryRun: true,
  db: 'docker',
  noDocker: false,
  syntheticBasemap: false,
  help: false,
} as const;
const REAL = { ...DRY, dryRun: false } as const;

describe('arguments', () => {
  test('flags', () => {
    expect(parseBootstrapArgs([])).toEqual({
      dryRun: false,
      db: 'docker',
      noDocker: false,
      syntheticBasemap: false,
      help: false,
    });
    expect(parseBootstrapArgs(['--synthetic-basemap'])).toMatchObject({ syntheticBasemap: true });
    expect(parseBootstrapArgs(['--dry-run', '--db=external'])).toMatchObject({
      dryRun: true,
      db: 'external',
    });
    expect(parseBootstrapArgs(['--no-docker'])).toMatchObject({ noDocker: true, db: 'external' });
    expect(() => parseBootstrapArgs(['--fast'])).toThrow(/unknown argument/);
  });
});

describe('checks', () => {
  test('Node 24 passes; another major fails with the exact fix for the OS', () => {
    expect(nodeVersionCheck('24.22.2', 'win32').status).toBe('PASS');
    const win = nodeVersionCheck('26.1.0', 'win32');
    expect(win.status).toBe('FAIL');
    expect(win.fix).toMatch(
      /winget install --id OpenJS\.NodeJS\.LTS --version 24\.\d+\.\d+ --exact --force/,
    );
    expect(win.fix).toMatch(/nodejs\.org\/dist\/latest-v24\.x/);
    expect(nodeVersionCheck('v22.12.0', 'darwin').fix).toMatch(/brew install node@24/);
    expect(nodeVersionCheck('22.12.0', 'linux').fix).toMatch(/fnm install 24/);
  });

  test('OneDrive folders are detected, look-alikes are not', () => {
    expect(oneDriveSegment('C:\\Users\\derrick\\OneDrive\\Desktop\\farm-manager')).toBe('OneDrive');
    expect(oneDriveSegment('C:\\Users\\derrick\\OneDrive - Hopson Farms\\farm')).toBe(
      'OneDrive - Hopson Farms',
    );
    expect(oneDriveSegment('C:\\dev\\farm-manager')).toBeNull();
    expect(oneDriveSegment('/home/u/onedrive-notes/farm')).toBeNull();
  });

  test('db:check table parsing; pg_cron/pg_net rows are expected to fail outside postgres', () => {
    const out = [
      'CHECK                                    RESULT  DETAIL',
      '---------------------------------------  ------  ------',
      'server is PostgreSQL 17                  PASS    17.11 as postgres in farm_dev_runtime',
      'pg_cron in postgres                      FAIL    create failed: can only create extension in database postgres',
      'farm_app can log in (DATABASE_URL)       PASS    ok',
      '',
      '1 FAIL (3 checks)',
    ].join('\n');
    const rows = parseCheckTable(out);
    expect(rows.map((r) => r.status)).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(unexpectedCheckFailures(rows, 'farm_dev_runtime')).toEqual([]);
    expect(unexpectedCheckFailures(rows, 'postgres')).toEqual(['pg_cron in postgres']);
    expect(
      unexpectedCheckFailures([{ check: 'PostGIS 3.3.x', status: 'FAIL' }], 'farm_dev_runtime'),
    ).toEqual(['PostGIS 3.3.x']);
  });

  test('basemap state follows basemap.json and the file it names', () => {
    const root = tmp();
    expect(basemapState(root)).toEqual({
      ok: false,
      synthetic: false,
      detail: 'tiles/basemap.json missing',
    });
    mkdirSync(path.join(root, 'tiles'));
    writeFileSync(
      path.join(root, 'tiles', 'basemap.json'),
      JSON.stringify({ key: 'basemap.abcd1234.pmtiles', build: '20261028.pmtiles' }),
    );
    expect(basemapState(root).ok).toBe(false);
    writeFileSync(path.join(root, 'tiles', 'basemap.abcd1234.pmtiles'), 'x');
    expect(basemapState(root)).toEqual({
      ok: true,
      synthetic: false,
      detail: 'basemap.abcd1234.pmtiles',
    });
    writeFileSync(path.join(root, 'tiles', 'basemap.json'), '{nope');
    expect(basemapState(root).detail).toMatch(/unreadable/);
  });

  test('the synthetic test basemap counts as missing unless --synthetic-basemap', () => {
    const root = tmp();
    mkdirSync(path.join(root, 'tiles'));
    writeFileSync(path.join(root, 'tiles', 'basemap.3af318ec.pmtiles'), 'x');
    writeFileSync(
      path.join(root, 'tiles', 'basemap.json'),
      JSON.stringify({ key: 'basemap.3af318ec.pmtiles', build: 'local:synthetic-se-michigan' }),
    );
    expect(basemapState(root)).toMatchObject({ ok: false, synthetic: true });
    expect(basemapState(root).detail).toMatch(/only the synthetic test basemap/);
    expect(basemapState(root, { acceptSynthetic: true })).toEqual({
      ok: true,
      synthetic: true,
      detail: 'basemap.3af318ec.pmtiles (synthetic test basemap)',
    });
  });
});

describe('bootstrap runs (injected dependencies)', () => {
  test('--dry-run on a Windows CI runner (no Docker, no env files) passes and writes nothing', async () => {
    const dir = tmp();
    const d = fakeDeps({ projectDir: dir });
    expect(await bootstrap(DRY, d)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    const text = d.lines.join('\n');
    expect(text).toMatch(/dry run: nothing is changed/);
    expect(text).toMatch(/WARN\s+Docker running/);
    expect(text).toMatch(/TODO\s+\.env \+ \.env\.local\s+would add DB_PASSWORD, DB_PORT/);
    expect(text).toMatch(/TODO\s+database\s+would start it/);
    expect(text).toMatch(/SKIP\s+demo seed\s+scripts\/seed\.ts missing from this checkout/);
    expect(text).toMatch(/SKIP\s+offline basemap/);
    expect(text).toMatch(/Dry run complete: nothing was changed\./);
    expect(text).toMatch(/New-NetFirewallRule -DisplayName 'farm-ops dev' .*-LocalPort 3000,3443/);
  });

  test('a real run without Docker stops at the checks and writes nothing', async () => {
    const dir = tmp();
    const d = fakeDeps({ projectDir: dir });
    expect(await bootstrap(REAL, d)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/FAIL\s+Docker running[\s\S]*Start Docker Desktop/);
  });

  test('the wrong Node stops before anything else', async () => {
    const d = fakeDeps({ projectDir: tmp(), nodeVersion: '26.0.0' });
    expect(await bootstrap(DRY, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(/FAIL\s+Node\.js 24\s+found v26\.0\.0/);
  });

  test('a repo under OneDrive fails', async () => {
    const base = tmp();
    const dir = path.join(base, 'OneDrive', 'farm');
    mkdirSync(dir, { recursive: true });
    const d = fakeDeps({ projectDir: dir });
    expect(await bootstrap(DRY, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(/FAIL\s+repo folder not under OneDrive/);
  });

  test('stops when a database volume exists but .env (its password) is gone', async () => {
    const dir = tmp();
    const d = fakeDeps({
      projectDir: dir,
      dockerAvailable: async () => ({ ok: true, version: '29.0.0' }),
      pgdataVolumes: async () => ['farm-manager_pgdata'],
    });
    expect(await bootstrap(REAL, d)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/pnpm db:nuke/);
  });

  test('ports: in use by another program fails; held by this project passes', async () => {
    const dir = tmp();
    // Existing env files so the config loads; the database is unreachable on purpose.
    writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=x\nDB_PORT=15432\n');
    const cfg = parseConfig(
      {
        DATABASE_URL: 'postgres://farm_app:pw@127.0.0.1:1/postgres',
        DATABASE_URL_MIGRATE: 'postgres://postgres:pw@127.0.0.1:1/postgres',
        JOBS_SECRET: 'j'.repeat(64),
        SESSION_SECRET: 's'.repeat(64),
        PUBLIC_URL: 'http://localhost:3104',
      },
      dir,
    );
    const busy = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      dockerAvailable: async () => ({ ok: true, version: '29.0.0' }),
      probePort: async (port) => ({ state: port === 3104 ? 'in_use' : 'free' }),
    });
    expect(await bootstrap(DRY, busy)).toBe(1);
    expect(busy.lines.join('\n')).toMatch(/FAIL\s+port 3104 \(Next\)\s+in use by another program/);

    const ours = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      dockerAvailable: async () => ({ ok: true, version: '29.0.0' }),
      dbContainer: async () => ({ id: 'abc', health: 'healthy' }),
      probePort: async () => ({ state: 'in_use' }),
      isOurApp: async () => true,
      isStandIn: async () => true,
    });
    expect(await bootstrap(DRY, ours)).toBe(0);
    const text = ours.lines.join('\n');
    expect(text).toMatch(/PASS\s+port 3104 \(Next\)\s+in use by this project's app/);
    expect(text).toMatch(
      /PASS\s+port 15432 \(DB_PORT\)\s+held by this project's database container/,
    );
    expect(text).toMatch(/PASS\s+port 4010 \(vendor stand-in\)\s+in use by the vendor stand-in/);
    expect(text).toMatch(/TODO\s+database\s+would run docker compose up -d db/);

    // Windows excluded port ranges: connect says free, bind says EACCES.
    const reserved = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      dockerAvailable: async () => ({ ok: true, version: '29.0.0' }),
      probePort: async (port) =>
        port === 3104 || port === 4010 ? { state: 'reserved', code: 'EACCES' } : { state: 'free' },
    });
    expect(await bootstrap(DRY, reserved)).toBe(1);
    const why = reserved.lines.join('\n');
    expect(why).toMatch(/FAIL\s+port 3104 \(Next\)\s+reserved by Windows \(excluded port range\)/);
    expect(why).toMatch(/FAIL\s+port 4010 \(vendor stand-in\)\s+reserved by Windows/);
    expect(why).toContain('netsh interface ipv4 show excludedportrange protocol=tcp');
    expect(why).toContain('VENDOR_SIM_URL in .env.local');
  });
});

describe('optional builders (seed, basemap, sim connect)', () => {
  function project(): { dir: string; cfg: ReturnType<typeof parseConfig> } {
    const dir = tmp();
    for (const f of ['scripts/seed.ts', 'tools/gis/basemap.ts', 'tools/vendor-sim/connect.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), '// stub');
    }
    writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=x\nDB_PORT=15432\n');
    const cfg = parseConfig(
      {
        DATABASE_URL: 'postgres://farm_app:pw@127.0.0.1:1/postgres',
        DATABASE_URL_MIGRATE: 'postgres://postgres:pw@127.0.0.1:1/postgres',
        JOBS_SECRET: 'j'.repeat(64),
        SESSION_SECRET: 's'.repeat(64),
      },
      dir,
    );
    return { dir, cfg };
  }
  const EXTERNAL = {
    dryRun: false,
    db: 'external',
    noDocker: false,
    syntheticBasemap: false,
    help: false,
  } as const;

  test('runs the seed, builds the missing basemap and the sim connect step', async () => {
    const { dir, cfg } = project();
    const calls: string[] = [];
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => true,
      runTsx: async (entry, args) => {
        calls.push([entry.split(path.sep).join('/'), ...args].join(' '));
        if (entry.endsWith('basemap.ts')) {
          const tiles = path.join(dir, '.data', 'storage', 'tiles');
          mkdirSync(tiles, { recursive: true });
          writeFileSync(path.join(tiles, 'basemap.0badf00d.pmtiles'), 'x');
          writeFileSync(
            path.join(tiles, 'basemap.json'),
            JSON.stringify({ key: 'basemap.0badf00d.pmtiles' }),
          );
        }
        return 0;
      },
    });
    expect(await bootstrap(EXTERNAL, d)).toBe(0);
    expect(calls).toEqual([
      'scripts/seed.ts demo',
      'tools/gis/basemap.ts',
      'tools/vendor-sim/connect.ts',
    ]);
    expect(d.lines.join('\n')).toMatch(/DONE\s+offline basemap\s+basemap\.0badf00d\.pmtiles/);
  });

  test('--synthetic-basemap installs the synthetic one; a plain run replaces it', async () => {
    const { dir, cfg } = project();
    const tiles = path.join(dir, '.data', 'storage', 'tiles');
    const calls: string[] = [];
    const runTsx = async (entry: string, args: string[]) => {
      calls.push([path.basename(entry), ...args].join(' '));
      if (entry.endsWith('basemap.ts')) {
        const synthetic = args.includes('--synthetic');
        const key = synthetic ? 'basemap.3af318ec.pmtiles' : 'basemap.0badf00d.pmtiles';
        mkdirSync(tiles, { recursive: true });
        writeFileSync(path.join(tiles, key), 'x');
        writeFileSync(
          path.join(tiles, 'basemap.json'),
          JSON.stringify({
            key,
            build: synthetic ? 'local:synthetic-se-michigan' : '20261028.pmtiles',
          }),
        );
      }
      return 0;
    };
    const deps = () =>
      fakeDeps({
        projectDir: dir,
        loadConfig: () => ({ ok: true, config: cfg }),
        database: async () => true,
        runTsx,
      });
    expect(await bootstrap({ ...EXTERNAL, syntheticBasemap: true }, deps())).toBe(0);
    expect(calls).toContain('basemap.ts --synthetic');
    calls.length = 0;
    // Accepted as is on the next --synthetic-basemap run.
    expect(await bootstrap({ ...EXTERNAL, syntheticBasemap: true }, deps())).toBe(0);
    expect(calls).toEqual(['seed.ts demo', 'connect.ts']);
    // A plain bootstrap fetches the real extract.
    const d = deps();
    expect(await bootstrap(EXTERNAL, d)).toBe(0);
    expect(calls).toContain('basemap.ts');
    expect(d.lines.join('\n')).toMatch(/only the synthetic test basemap is installed/);
  });

  test('--no-docker cannot build a basemap: it says so instead of calling Docker', async () => {
    const { dir, cfg } = project();
    const calls: string[] = [];
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => true,
      runTsx: async (entry) => {
        calls.push(path.basename(entry));
        return 0;
      },
    });
    expect(await bootstrap({ ...EXTERNAL, noDocker: true }, d)).toBe(1);
    expect(calls).toEqual(['seed.ts']);
    expect(d.lines.join('\n')).toMatch(/gis:basemap` needs Docker/);
  });

  test('an existing basemap is not rebuilt', async () => {
    const { dir, cfg } = project();
    const tiles = path.join(dir, '.data', 'storage', 'tiles');
    mkdirSync(tiles, { recursive: true });
    writeFileSync(path.join(tiles, 'basemap.1.pmtiles'), 'x');
    writeFileSync(
      path.join(tiles, 'basemap.json'),
      JSON.stringify({ key: 'basemap.1.pmtiles', build: '20261028.pmtiles' }),
    );
    const calls: string[] = [];
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => true,
      runTsx: async (entry) => {
        calls.push(path.basename(entry));
        return 0;
      },
    });
    expect(await bootstrap(EXTERNAL, d)).toBe(0);
    expect(calls).toEqual(['seed.ts', 'connect.ts']);
  });

  test('a failing basemap build stops bootstrap loudly (no silent online fallback)', async () => {
    const { dir, cfg } = project();
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => true,
      runTsx: async (entry) => (entry.endsWith('basemap.ts') ? 1 : 0),
    });
    expect(await bootstrap(EXTERNAL, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(
      /bootstrap stopped: offline basemap missing, run `pnpm gis:basemap`/,
    );
  });

  test('a failing seed stops bootstrap with the command to retry', async () => {
    const { dir, cfg } = project();
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => true,
      runTsx: async () => 3,
    });
    expect(await bootstrap(EXTERNAL, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(/demo seed failed \(exit 3\); run `pnpm db:seed demo`/);
  });

  test('a failing database step stops before the builders', async () => {
    const { dir, cfg } = project();
    const d = fakeDeps({
      projectDir: dir,
      loadConfig: () => ({ ok: true, config: cfg }),
      database: async () => false,
    });
    expect(await bootstrap(EXTERNAL, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(/database setup failed/);
  });
});

describe('the CLI', () => {
  test('`bootstrap --dry-run --no-docker` exits 0 and leaves the env files untouched', async () => {
    const root = process.cwd();
    const envFiles = ['.env', '.env.local', '.env.development.local'].map((f) =>
      path.join(root, f),
    );
    const before = envFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null));
    const r = await runNode(tsxBin(), ['scripts/bootstrap.ts', '--dry-run', '--no-docker'], {
      cwd: root,
      timeoutMs: 120_000,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Dry run complete: nothing was changed\./);
    expect(envFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null))).toEqual(before);
  }, 120_000);

  test('unknown flags exit 2 with the usage', async () => {
    const r = await runNode(tsxBin(), ['scripts/bootstrap.ts', '--nope'], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: pnpm run bootstrap/);
  }, 60_000);
});
