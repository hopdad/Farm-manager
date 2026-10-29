/**
 * `pnpm gis:basemap`: the offline basemap (plan §2 step 6, contracts §10). Owner: map.
 *
 *   pnpm gis:basemap                    install if missing or synthetic (newest Protomaps build), else no-op
 *   pnpm gis:basemap --refresh          re-resolve the newest build; re-extract if it changed
 *   pnpm gis:basemap --source=<x>       extract from <x>: a build key (20261028.pmtiles), an
 *                                       https URL, or a local .pmtiles file (offline re-extract,
 *                                       or the synthetic test fixture: tools/gis/synthetic-basemap.ts)
 *   pnpm gis:basemap --synthetic        install the synthetic test fixture (CI/e2e, or no access
 *                                       to build.protomaps.com); the board badges it, and a plain
 *                                       `pnpm gis:basemap` later replaces it with a real build
 *   pnpm gis:basemap --assets-only      fonts and sprites only
 *
 * Steps, each idempotent:
 *   1. fonts + sprites from the pinned protomaps/basemaps-assets commit → tiles/assets/ (./assets.ts)
 *   2. resolve the newest Protomaps daily build from the builds listing, falling back to the
 *      latest patch-version build (./builds.ts)
 *   3. `pmtiles extract <build> --bbox=-84.45,41.65,-83.10,42.15 --maxzoom=15` in
 *      protomaps/go-pmtiles:v1.31.2 into the gis_work volume, verify, copy out (./extract.ts)
 *   4. install as tiles/basemap.<sha8>.pmtiles (content-addressed, never overwritten)
 *   5. write tiles/basemap.json last, atomically; then delete older basemap.*.pmtiles
 *
 * Any failure exits non-zero and leaves an existing basemap in place. It never falls back to an
 * online style: the board shows "basemap missing" instead.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { type FileHandle, mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PMTiles, type Header as PmtilesHeader, type Source } from 'pmtiles';
import { getConfig } from '../../src/config';
import { isMainModule } from '../../src/lib/proc';
import {
  BASEMAP_BBOX,
  BASEMAP_MANIFEST_KEY,
  BASEMAP_MAXZOOM,
  type BasemapManifest,
  basemapManifestSchema,
  isSyntheticBasemap,
  readBasemapStatus,
} from '../../src/platform/storage/basemap';
import { LocalStorage, storageRoot } from '../../src/platform/storage/local';
import { BASEMAPS_ASSETS_COMMIT, syncAssets } from './assets';
import { buildUrl, PROTOMAPS_BUILD_BASE, resolveBuild } from './builds';
import { type ExtractInput, extractToHost } from './extract';
import { installContentAddressed, removeOtherVersions, writeFileAtomic } from './files';
import { describeError } from './http';
import { buildSyntheticBasemap, SYNTHETIC_FILE_NAME } from './synthetic-basemap';

const log = (msg: string) => console.log(`[gis:basemap] ${msg}`);

export interface BasemapArgs {
  source?: string;
  synthetic: boolean;
  refresh: boolean;
  assetsOnly: boolean;
  help: boolean;
}

export function parseBasemapArgs(argv: string[]): BasemapArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      synthetic: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'assets-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.source && values.synthetic)
    throw new Error('--source and --synthetic exclude each other');
  return {
    source: values.source,
    synthetic: values.synthetic ?? false,
    refresh: values.refresh ?? false,
    assetsOnly: values['assets-only'] ?? false,
    help: values.help ?? false,
  };
}

export interface ResolvedSource {
  input: ExtractInput;
  /** basemap.json `build`. */
  build: string;
}

/** --source=<build key | URL | file> → extract input + the `build` label. */
export function resolveSourceArg(source: string, cwd = process.cwd()): ResolvedSource {
  if (/^\d{8}\.pmtiles$/.test(source)) {
    return { input: { kind: 'url', url: buildUrl(source) }, build: source };
  }
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const key = url.pathname.split('/').pop() ?? '';
    const isBuild = url.href.startsWith(PROTOMAPS_BUILD_BASE) && /^\d{8}\.pmtiles$/.test(key);
    return { input: { kind: 'url', url: url.href }, build: isBuild ? key : `url:${url.href}` };
  }
  const file = path.resolve(cwd, source);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(
      `--source: ${file} is not a file (expected a build key, an https URL or a .pmtiles file)`,
    );
  }
  const name = path.basename(file).replace(/\.pmtiles$/i, '');
  return { input: { kind: 'file', path: file }, build: `local:${name}` };
}

/** Problems with an extracted archive's header (empty = fine). */
export function headerProblems(
  h: Pick<
    PmtilesHeader,
    'specVersion' | 'tileType' | 'maxZoom' | 'minLon' | 'minLat' | 'maxLon' | 'maxLat'
  >,
  bbox: readonly [number, number, number, number] = BASEMAP_BBOX,
  maxzoom = BASEMAP_MAXZOOM,
): string[] {
  const out: string[] = [];
  if (h.specVersion !== 3) out.push(`spec version ${h.specVersion}, expected 3`);
  if (h.tileType !== 1) out.push(`tile type ${h.tileType}, expected 1 (MVT)`);
  if (h.maxZoom > maxzoom) out.push(`max zoom ${h.maxZoom} exceeds ${maxzoom}`);
  const overlaps =
    h.minLon < bbox[2] && bbox[0] < h.maxLon && h.minLat < bbox[3] && bbox[1] < h.maxLat;
  if (!overlaps)
    out.push(`bounds ${[h.minLon, h.minLat, h.maxLon, h.maxLat].join(',')} miss the AOI`);
  return out;
}

class FileSource implements Source {
  constructor(
    private readonly fh: FileHandle,
    private readonly key: string,
  ) {}
  getKey() {
    return this.key;
  }
  async getBytes(offset: number, length: number) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer };
  }
}

async function readHeader(file: string): Promise<PmtilesHeader> {
  const fh = await open(file, 'r');
  try {
    return await new PMTiles(new FileSource(fh, file)).getHeader();
  } finally {
    await fh.close();
  }
}

export async function runBasemap(args: BasemapArgs): Promise<void> {
  const cfg = getConfig();
  const root = storageRoot(cfg);
  const tilesDir = path.join(root, 'tiles');
  const assetsDir = path.join(tilesDir, 'assets');
  const storage = new LocalStorage(root);

  // 1. Fonts and sprites.
  const assets = await syncAssets(assetsDir, { log });
  log(
    assets.downloaded
      ? `assets: downloaded ${assets.downloaded} files (${(assets.bytes / 1e6).toFixed(1)} MB)`
      : `assets: ${assets.total} files present (basemaps-assets@${assets.commit.slice(0, 7)})`,
  );
  if (args.assetsOnly) return;

  // 2. Which archive?
  const tmpDir = path.join(root, '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const current = await readBasemapStatus(storage);
  let source: ResolvedSource;
  const cleanup: string[] = [];
  if (args.synthetic) {
    const file = path.join(tmpDir, SYNTHETIC_FILE_NAME);
    await writeFile(file, buildSyntheticBasemap());
    cleanup.push(file);
    source = resolveSourceArg(file);
    log('installing the synthetic test basemap (not real map data)');
  } else if (args.source) {
    source = resolveSourceArg(args.source);
  } else {
    const synthetic = current.ok && isSyntheticBasemap(current.manifest);
    if (current.ok && !args.refresh && !synthetic) {
      await refreshAssetsCommit(tilesDir, current.manifest);
      log(
        `up to date: tiles/${current.manifest.key} (build ${current.manifest.build}); --refresh fetches the newest build`,
      );
      return;
    }
    if (synthetic)
      log('the installed basemap is the synthetic test fixture; fetching a real build');
    if (!current.ok && current.reason !== 'missing')
      log(`current basemap unusable: ${current.detail}`);
    log('resolving the newest Protomaps build');
    const resolved = await resolveBuild();
    log(`build ${resolved.build.key} (tileset ${resolved.build.version})`);
    if (current.ok && current.manifest.build === resolved.build.key) {
      await refreshAssetsCommit(tilesDir, current.manifest);
      log(`up to date: tiles/${current.manifest.key} is build ${resolved.build.key}`);
      return;
    }
    source = { input: { kind: 'url', url: resolved.url }, build: resolved.build.key };
  }

  // 3. Extract into the gis_work volume and copy the verified archive out.
  const tmp = path.join(tmpDir, `basemap-${randomBytes(4).toString('hex')}.pmtiles`);
  try {
    await extractToHost({
      input: source.input,
      hostOut: tmp,
      bbox: BASEMAP_BBOX,
      maxzoom: BASEMAP_MAXZOOM,
      log,
    });
    const problems = headerProblems(await readHeader(tmp));
    if (problems.length) throw new Error(`extracted archive rejected: ${problems.join('; ')}`);

    // 4. Content-addressed install.
    const installed = await installContentAddressed(tmp, tilesDir, 'basemap', 'pmtiles');
    log(
      `${installed.created ? 'installed' : 'already present:'} tiles/${installed.key} (${(installed.bytes / 1e6).toFixed(1)} MB)`,
    );

    // 5. basemap.json last, atomically; then old versions.
    const manifest: BasemapManifest = basemapManifestSchema.parse({
      key: installed.key,
      sha8: installed.sha256.slice(0, 8),
      bytes: installed.bytes,
      builtAt: new Date().toISOString(),
      build: source.build,
      bbox: [...BASEMAP_BBOX],
      maxzoom: BASEMAP_MAXZOOM,
      assetsCommit: assets.commit,
    } satisfies BasemapManifest);
    await writeManifest(tilesDir, manifest);
    const removed = await removeOtherVersions(tilesDir, 'basemap', 'pmtiles', installed.key);
    if (removed.length) log(`removed older ${removed.join(', ')}`);
    log(`done: tiles/${BASEMAP_MANIFEST_KEY} → ${installed.key} (build ${source.build})`);
  } finally {
    for (const f of [tmp, ...cleanup]) await rm(f, { force: true });
  }
}

async function writeManifest(tilesDir: string, m: BasemapManifest): Promise<void> {
  await writeFileAtomic(
    path.join(tilesDir, BASEMAP_MANIFEST_KEY),
    `${JSON.stringify(m, null, 2)}\n`,
  );
}

/** A newer pinned assets commit (after an upgrade) is recorded without re-extracting. */
async function refreshAssetsCommit(tilesDir: string, m: BasemapManifest): Promise<void> {
  if (m.assetsCommit === BASEMAPS_ASSETS_COMMIT) return;
  await writeManifest(tilesDir, { ...m, assetsCommit: BASEMAPS_ASSETS_COMMIT });
}

const USAGE =
  'usage: pnpm gis:basemap [--refresh] [--source=<build key | https URL | file.pmtiles> | --synthetic] [--assets-only]';

async function main(): Promise<void> {
  let args: BasemapArgs;
  try {
    args = parseBasemapArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await runBasemap(args);
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`[gis:basemap] FAILED: ${describeError(e)}`);
      console.error(
        '[gis:basemap] the offline basemap was not installed or updated (an existing one is kept). ' +
          'Fix the cause above and re-run `pnpm gis:basemap`. Behind a proxy, set NODE_USE_ENV_PROXY=1.',
      );
      process.exit(1);
    },
  );
}
