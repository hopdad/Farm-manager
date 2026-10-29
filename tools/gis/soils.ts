/**
 * `pnpm gis:soils`: SSURGO soils for Lenawee (MI091) and Monroe (MI115) from NRCS Soil Data
 * Access, county-wide, then the per-boundary clip (plan §5 "Soils", §6 1c). Owner: soils.
 *
 *   pnpm gis:soils                    download both counties into data/raw/soils/<date>/ and load
 *                                     them (a complete download from today is reused)
 *   pnpm gis:soils --refresh          download again even if today's is there
 *   pnpm gis:soils --offline          load the newest complete download in data/raw/soils; no
 *                                     network (`--run=<name>` picks one, e.g. 2026-10-29)
 *   pnpm gis:soils --fixture          load the committed SYNTHETIC fixture (tools/gis/fixtures/soils:
 *                                     SDA-shaped replies, fictional mukeys and shapes around the demo
 *                                     fields) for demos and CI when SDA can't be reached. Refused on a
 *                                     database outside this PC, and over real SSURGO data unless --force
 *   pnpm gis:soils --areas=MI091      some survey areas only
 *   pnpm gis:soils --download-only    fill the cache, leave the database alone
 *
 * The download (./soils-fetch.ts) never touches the database and the load (./soils-load.ts)
 * never touches the network, so `--offline` reproduces exactly what a live run loaded. Loads go
 * through DATABASE_URL as farm_app; gis.field_soils is rebuilt in SQL for every boundary version
 * and the board's soils layer and open field panels refresh over realtime.
 *
 * Behind a proxy, run with NODE_USE_ENV_PROXY=1 (Node 24 then honours HTTPS_PROXY).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig } from '../../src/config';
import { assertLocalUrl } from '../../src/db/admin';
import { createPool } from '../../src/db/client';
import { SOIL_SURVEY_AREAS } from '../../src/domain/soils';
import { isMainModule } from '../../src/lib/proc';
import { describeError } from './http';
import { fetchSoilsRun } from './soils-fetch';
import { formatLoadReport, loadSoilsRun } from './soils-load';
import { listRuns, openRun, rawRoot, type SoilsRun } from './soils-raw';
import { SdaError } from './soils-sda';
import { areaSymbol } from './soils-sql';

const log = (msg: string) => console.log(`[gis:soils] ${msg}`);

/** The committed synthetic fixture (a run directory). */
export const FIXTURE_DIR = path.join('tools', 'gis', 'fixtures', 'soils');

export type SoilsMode = 'download' | 'offline' | 'fixture';

export interface SoilsArgs {
  mode: SoilsMode;
  refresh: boolean;
  run: string | null;
  areas: string[];
  downloadOnly: boolean;
  force: boolean;
  help: boolean;
}

export const USAGE =
  'usage: pnpm gis:soils [--refresh | --offline [--run=<name>] | --fixture [--force]] [--areas=MI091,MI115] [--download-only]';

export function parseSoilsArgs(argv: string[]): SoilsArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      refresh: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      fixture: { type: 'boolean', default: false },
      run: { type: 'string' },
      areas: { type: 'string' },
      'download-only': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const offline = values.offline ?? false;
  const fixture = values.fixture ?? false;
  const refresh = values.refresh ?? false;
  const downloadOnly = values['download-only'] ?? false;
  if ([offline, fixture, refresh].filter(Boolean).length > 1) {
    throw new Error('--refresh, --offline and --fixture exclude each other');
  }
  if (values.run !== undefined && !offline) throw new Error('--run needs --offline');
  if (downloadOnly && (offline || fixture)) {
    throw new Error('--download-only downloads; it excludes --offline and --fixture');
  }
  if (values.force && !fixture) throw new Error('--force only applies to --fixture');
  const areas = (values.areas ?? SOIL_SURVEY_AREAS.join(','))
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(areaSymbol);
  if (areas.length === 0) throw new Error('--areas is empty');
  if (values.run !== undefined && !/^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(values.run)) {
    throw new Error(`--run=${values.run}: expected a run name such as 2026-10-29`);
  }
  return {
    mode: fixture ? 'fixture' : offline ? 'offline' : 'download',
    refresh,
    run: values.run ?? null,
    areas: [...new Set(areas)].sort(),
    downloadOnly,
    force: values.force ?? false,
    help: values.help ?? false,
  };
}

const covers = (runAreas: readonly string[], wanted: readonly string[]) =>
  wanted.every((a) => runAreas.includes(a));

/** Which run to load (downloading one first when needed). */
export async function resolveRun(
  args: SoilsArgs,
  projectDir: string,
  now: () => Date = () => new Date(),
): Promise<SoilsRun> {
  const root = rawRoot(projectDir);
  if (args.mode === 'fixture') return openRun(path.join(projectDir, FIXTURE_DIR));
  if (args.mode === 'offline') {
    const runs = await listRuns(root);
    const pick = args.run
      ? runs.find((r) => r.name === args.run)
      : runs.find((r) => covers(r.index.areas, args.areas));
    if (!pick) {
      throw new Error(
        args.run
          ? `no complete soils download named ${args.run} under ${path.join(root, 'soils')}`
          : `no complete soils download for ${args.areas.join(', ')} under ${path.join(root, 'soils')}: run pnpm gis:soils online first`,
      );
    }
    if (!covers(pick.index.areas, args.areas)) {
      throw new Error(
        `download ${pick.name} has ${pick.index.areas.join(', ')}, not ${args.areas.join(', ')}`,
      );
    }
    log(`offline: using data/raw/soils/${pick.name} (${pick.index.finishedAt})`);
    return openRun(pick.dir);
  }
  if (!args.refresh) {
    const today = now().toISOString().slice(0, 10);
    const cached = (await listRuns(root)).find(
      (r) =>
        !r.index.fixture &&
        r.index.finishedAt.slice(0, 10) === today &&
        r.index.areas.join(',') === args.areas.join(','),
    );
    if (cached) {
      log(`reusing today's download data/raw/soils/${cached.name} (--refresh downloads again)`);
      return openRun(cached.dir);
    }
  }
  log(`downloading ${args.areas.join(', ')} from Soil Data Access`);
  const res = await fetchSoilsRun({ areas: args.areas, rawRoot: root, now, log });
  log(
    `downloaded ${res.index.files.length} replies into ${path.relative(projectDir, res.dir)}${res.splits ? ` (${res.splits} request(s) split)` : ''}`,
  );
  return openRun(res.dir);
}

export async function runSoils(args: SoilsArgs): Promise<void> {
  const cfg = getConfig();
  if (args.mode === 'fixture') {
    if (cfg.isProduction) throw new Error('the synthetic soils fixture never loads in production');
    assertLocalUrl(cfg.DATABASE_URL, 'gis:soils --fixture');
  }
  const run = await resolveRun(args, cfg.projectDir);
  if (args.downloadOnly) {
    log('download only: the database was not touched');
    return;
  }
  if (run.index.fixture) log(`SYNTHETIC FIXTURE: ${run.index.fixture}`);
  const pool = createPool({ max: 2, applicationName: 'gis:soils' });
  try {
    const report = await loadSoilsRun(pool, run, { log, force: args.force });
    for (const line of formatLoadReport(report).split('\n')) log(line);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  let args: SoilsArgs;
  try {
    args = parseSoilsArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await runSoils(args);
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`[gis:soils] FAILED: ${describeError(e)}`);
      if (e instanceof SdaError && (e.kind === 'network' || e.kind === 'unavailable')) {
        console.error(
          '[gis:soils] Soil Data Access could not be reached. Try again later (it has a daily maintenance window ' +
            'around 12:30 AM CST); behind a proxy set NODE_USE_ENV_PROXY=1. For a demo without it: pnpm gis:soils --fixture',
        );
      }
      console.error('[gis:soils] nothing was changed in the database.');
      process.exit(1);
    },
  );
}
