/**
 * `pnpm gis:naip`: aerial photos (plan §5 "Aerial photos (NAIP)", 1d). Steps and rules:
 * ./naip-build.ts.
 *
 *   pnpm gis:naip                   online layer + download the AOI close-ups + build + install
 *   pnpm gis:naip --online-only     just the online layer's registry row (no download)
 *   pnpm gis:naip --offline         rebuild the close-ups from the newest run in data/raw/naip
 *   pnpm gis:naip --fixture         the whole pipeline on synthetic tiles (no network; CI, tests,
 *                                   machines that can't reach imagery.nationalmap.gov)
 *
 * Options: --aoi <file.geojson> (default data/aoi.geojson, else your fields + 1 mile),
 * --minzoom 12, --maxzoom 17, --max-tiles 60000, --concurrency 4,
 * --vintage "NAIP 2024" (shown on the map; the latest Michigan year is listed by the NAIP index
 * service, USGSNAIPImageryIndex/MapServer).
 *
 * Behind a proxy, Node needs NODE_USE_ENV_PROXY=1 to use HTTPS_PROXY.
 */
import { parseArgs } from 'node:util';
import { getConfig } from '../../src/config';
import { createPool } from '../../src/db/client';
import { isMainModule } from '../../src/lib/proc';
import { getStorageWriter } from '../../src/platform/storage/writer';
import { describeError, type FetchLike } from './http';
import {
  buildArchive,
  fetchRun,
  installAoiArchive,
  newestCompleteRun,
  resolveAoi,
  writeOnlineRow,
} from './naip-build';
import { naipFixtureFetch } from './naip-fixture';
import { NAIP_DEFAULT_MAX_TILES, NAIP_DEFAULT_MAXZOOM, NAIP_DEFAULT_MINZOOM } from './naip-tiles';

export const USAGE = `usage: pnpm gis:naip [--online-only | --offline | --fixture] [--aoi <file.geojson>]
                     [--minzoom 12] [--maxzoom 17] [--max-tiles 60000] [--concurrency 4]
                     [--vintage "NAIP 2024"]`;

export interface NaipArgs {
  mode: 'full' | 'online-only' | 'offline' | 'fixture';
  aoi?: string;
  minzoom: number;
  maxzoom: number;
  maxTiles: number;
  concurrency: number;
  vintage?: string;
  help: boolean;
}

function int(v: string | undefined, name: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`--${name} must be an integer ${min}..${max}`);
  return n;
}

export function parseNaipArgs(argv: readonly string[]): NaipArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'online-only': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      fixture: { type: 'boolean', default: false },
      aoi: { type: 'string' },
      minzoom: { type: 'string' },
      maxzoom: { type: 'string' },
      'max-tiles': { type: 'string' },
      concurrency: { type: 'string' },
      vintage: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const modes = (['online-only', 'offline', 'fixture'] as const).filter((m) => values[m] === true);
  if (modes.length > 1) throw new Error(`pick one of --${modes.join(', --')}`);
  const minzoom = int(values.minzoom, 'minzoom', NAIP_DEFAULT_MINZOOM, 8, 18);
  const maxzoom = int(values.maxzoom, 'maxzoom', NAIP_DEFAULT_MAXZOOM, 8, 18);
  if (minzoom > maxzoom) throw new Error('--minzoom must not be above --maxzoom');
  return {
    mode: modes[0] ?? 'full',
    aoi: values.aoi,
    minzoom,
    maxzoom,
    maxTiles: int(values['max-tiles'], 'max-tiles', NAIP_DEFAULT_MAX_TILES, 1, 1_000_000),
    concurrency: int(values.concurrency, 'concurrency', 4, 1, 16),
    vintage: values.vintage,
    help: values.help === true,
  };
}

export async function runNaip(
  args: NaipArgs,
  deps: { fetch?: FetchLike; log?: (m: string) => void } = {},
): Promise<void> {
  const log = (m: string) => (deps.log ?? console.log)(`[gis:naip] ${m}`);
  const cfg = getConfig();
  const pool = createPool({ connectionString: cfg.DATABASE_URL, max: 2 });
  try {
    const fixture = args.mode === 'fixture';
    await writeOnlineRow(pool, { vintage: args.vintage });
    log('online layer "naip" registered (needs the internet; shows "offline" without it)');
    if (args.mode === 'online-only') return;

    let run: Awaited<ReturnType<typeof newestCompleteRun>>;
    if (args.mode === 'offline') {
      run = await newestCompleteRun(cfg.projectDir);
      log(`rebuilding from ${run.dir} (${run.index.tiles.length} tiles)`);
    } else {
      const aoi = await resolveAoi(pool, cfg.projectDir, args.aoi);
      run = await fetchRun({
        projectDir: cfg.projectDir,
        aoi,
        minzoom: args.minzoom,
        maxzoom: args.maxzoom,
        maxTiles: args.maxTiles,
        fetch: deps.fetch ?? (fixture ? naipFixtureFetch() : fetch),
        fixture,
        concurrency: args.concurrency,
        log,
      });
    }
    const vintage = run.index.fixture
      ? 'NAIP FIXTURE (synthetic tiles, not imagery)'
      : (args.vintage ?? `NAIP, USGS mosaic fetched ${run.index.finishedAt.slice(0, 10)}`);
    const { archive, sha256 } = await buildArchive(run.dir, run.index, vintage);
    const r = await installAoiArchive(
      pool,
      getStorageWriter(),
      archive,
      sha256,
      run.index,
      vintage,
    );
    log(`installed tiles/${r.key} (${(r.bytes / 1e6).toFixed(1)} MB, version ${r.version})`);
    if (r.replaced) log(`removed the previous archive tiles/${r.replaced}`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  let args: NaipArgs;
  try {
    args = parseNaipArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await runNaip(args);
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`[gis:naip] FAILED: ${describeError(e)}`);
      console.error(
        '[gis:naip] the installed close-ups (if any) are unchanged; a partial download resumes on the next run. ' +
          'Behind a proxy set NODE_USE_ENV_PROXY=1; without internet use --offline (rebuild) or --fixture.',
      );
      process.exit(1);
    },
  );
}
