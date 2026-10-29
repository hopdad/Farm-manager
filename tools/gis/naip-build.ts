/**
 * `pnpm gis:naip` steps (plan §5 "Aerial photos (NAIP)", 1d): the online layer's registry row,
 * and the AOI close-up archive.
 *
 *  1. Online layer (`naip`, xyz): one gis.map_layers row pointing MapLibre at the USGS image
 *     service (./naip-tiles.ts). No download. Marked online-only (the rail shows "offline"
 *     without internet).
 *  2. AOI (plan §5: "owned, rented, customer and prospect ground plus a 1-mile buffer"):
 *     `data/aoi.geojson` when it exists (or `--aoi <file>`), else the current boundaries of every
 *     active field buffered by a mile, from the database.
 *  3. Download run: every Web Mercator tile touching the AOI at zooms min..max, one exportImage
 *     request each (JPEG, checked), into `data/raw/naip/<date>/tiles/z/x/y.jpg`, with
 *     `run.partial.json` while it runs (an interrupted run resumes) and `run.json` written last
 *     (every tile's sha256), plus one entry in data/raw/manifest.json.
 *  4. Build: the run's tiles into a raster PMTiles (JPEG tiles, ../gis/pmtiles-writer.ts),
 *     stored content-addressed in the `tiles` bucket as `naip/aoi.<sha8>.pmtiles` through the
 *     storage adapter (never overwritten; the previous archive is deleted only after the
 *     registry points at the new one, plan §1 "Raster layers").
 *  5. Registry row `naip_aoi` (pmtiles, public) with version = sha8, zooms, bounds, vintage;
 *     `layers`/`updated` published for both keys.
 *
 * `--offline` skips 2-3 and rebuilds from the newest complete run (ingest:all --offline).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bbox as turfBbox } from '@turf/turf';
import type { MultiPolygon, Polygon } from 'geojson';
import type pg from 'pg';
import { z } from 'zod';
import { publish } from '../../src/platform/realtime/publish';
import { contentAddressedName } from '../../src/platform/storage/keys';
import type { StorageWriter } from '../../src/platform/storage/types';
import type { TileCoord } from '../../src/ui/map/tile-math';
import { writeFileAtomic } from './files';
import { describeError, type FetchLike, fetchWithRetry } from './http';
import { newRunDir, rawRelative, rawRoot, recordDownloads, sha256Hex } from './naip-raw';
import {
  isJpeg,
  NAIP_IMAGE_SERVER,
  naipExportUrl,
  naipOnlineTemplate,
  tilePath,
  tilesForArea,
} from './naip-tiles';
import { PmCompression, PmTileType, writePmtiles } from './pmtiles-writer';

export const NAIP_SOURCE = 'naip' as const;
export const NAIP_LICENCE =
  'Public domain: USDA Farm Service Agency, National Agriculture Imagery Program (NAIP), via the USGS National Map.';
export const NAIP_ATTRIBUTION = 'Imagery: USDA NAIP via USGS The National Map';
/** One mile, the plan's AOI buffer around the fields. */
export const AOI_BUFFER_M = 1609.344;
export const AOI_FILE = path.join('data', 'aoi.geojson');

export type Area = Polygon | MultiPolygon;

export type NaipLog = (msg: string) => void;

// ---------------------------------------------------------------------------------------------
// 1. the online layer
// ---------------------------------------------------------------------------------------------

export async function writeOnlineRow(
  pool: pg.Pool,
  opts: { server?: string; vintage?: string } = {},
): Promise<void> {
  const server = opts.server ?? NAIP_IMAGE_SERVER;
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into gis.map_layers (key, kind, url_or_key, version, cache_policy, minzoom, maxzoom,
                                   attribution, legend, source_vintage, built_at, default_visible, meta)
       values ('naip', 'xyz', $1, null, 'public', 11, 19, $2, null, $3, now(), false, $4::jsonb)
       on conflict (key) do update
          set kind = excluded.kind, url_or_key = excluded.url_or_key, version = excluded.version,
              cache_policy = excluded.cache_policy, minzoom = excluded.minzoom,
              maxzoom = excluded.maxzoom, attribution = excluded.attribution,
              source_vintage = excluded.source_vintage, built_at = excluded.built_at,
              meta = excluded.meta, updated_at = now()`,
      [
        naipOnlineTemplate(server),
        NAIP_ATTRIBUTION,
        opts.vintage ?? 'NAIP, latest USGS mosaic',
        JSON.stringify({ onlineOnly: true, service: server }),
      ],
    );
    await publish('layers', 'updated', { key: 'naip', version: null }, c);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------------------------
// 2. the area of interest
// ---------------------------------------------------------------------------------------------

export interface Aoi {
  area: Area;
  /** sha256 of the AOI's GeoJSON text (a resumed run must have the same one). */
  sha256: string;
  from: string;
}

function areaOf(value: unknown, name: string): Area {
  const v = value as { type?: string; features?: { geometry?: unknown }[]; geometry?: unknown };
  const polys: Polygon['coordinates'][] = [];
  const take = (g: unknown) => {
    const geom = g as Area | null;
    if (geom?.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom?.type === 'MultiPolygon') polys.push(...geom.coordinates);
  };
  if (v?.type === 'FeatureCollection') for (const f of v.features ?? []) take(f.geometry);
  else if (v?.type === 'Feature') take(v.geometry);
  else take(v);
  if (polys.length === 0) throw new Error(`${name}: no polygon in the AOI`);
  return { type: 'MultiPolygon', coordinates: polys };
}

export async function resolveAoi(
  pool: pg.Pool,
  projectDir: string,
  aoiFile?: string,
): Promise<Aoi> {
  const file = aoiFile ?? path.join(projectDir, AOI_FILE);
  const text = await readFile(file, 'utf8').catch((e: unknown) => {
    if (aoiFile) throw e;
    return null;
  });
  if (text !== null) {
    return { area: areaOf(JSON.parse(text), file), sha256: sha256Hex(text), from: file };
  }
  const r = await pool.query<{ g: string | null }>(
    `select extensions.ST_AsGeoJSON(extensions.ST_SimplifyPreserveTopology(
              extensions.ST_Union(extensions.ST_Buffer(b.geom::extensions.geography, $1)::extensions.geometry),
              0.0002), 6) as g
       from farm.current_boundaries b
       join farm.fields f on f.id = b.field_id and f.active`,
    [AOI_BUFFER_M],
  );
  const g = r.rows[0]?.g;
  if (!g)
    throw new Error(
      'no fields to build an area of interest from: load fields, or give --aoi <file>',
    );
  return {
    area: areaOf(JSON.parse(g), 'fields'),
    sha256: sha256Hex(g),
    from: 'current field boundaries + 1 mile',
  };
}

// ---------------------------------------------------------------------------------------------
// 3. the download run
// ---------------------------------------------------------------------------------------------

const runParamsSchema = z.strictObject({
  format: z.literal(1),
  source: z.literal(NAIP_SOURCE),
  service: z.string().min(1),
  fixture: z.boolean(),
  aoiSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  minzoom: z.number().int(),
  maxzoom: z.number().int(),
  startedAt: z.iso.datetime({ offset: true }),
});
export type RunParams = z.infer<typeof runParamsSchema>;

export const runIndexSchema = runParamsSchema.extend({
  finishedAt: z.iso.datetime({ offset: true }),
  complete: z.literal(true),
  bytes: z.number().int().min(0),
  tiles: z.array(
    z.strictObject({
      z: z.number().int(),
      x: z.number().int(),
      y: z.number().int(),
      bytes: z.number().int().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});
export type RunIndex = z.infer<typeof runIndexSchema>;

export const RUN_INDEX_FILE = 'run.json';
export const RUN_PARTIAL_FILE = 'run.partial.json';

/** The newest run directory under data/raw/naip whose given file exists and passes `pick`. */
async function findRun<T>(
  root: string,
  file: string,
  parse: (text: string) => T | null,
): Promise<{ dir: string; value: T } | null> {
  const base = path.join(root, NAIP_SOURCE);
  const names = (await readdir(base).catch(() => [] as string[])).sort().reverse();
  for (const name of names) {
    const dir = path.join(base, name);
    const text = await readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (text === null) continue;
    const value = parse(text);
    if (value !== null) return { dir, value };
  }
  return null;
}

const sameParams = (a: RunParams, b: Omit<RunParams, 'startedAt'>) =>
  a.service === b.service &&
  a.fixture === b.fixture &&
  a.aoiSha256 === b.aoiSha256 &&
  a.minzoom === b.minzoom &&
  a.maxzoom === b.maxzoom;

export interface FetchRunOptions {
  projectDir: string;
  aoi: Aoi;
  minzoom: number;
  maxzoom: number;
  maxTiles: number;
  fetch: FetchLike;
  fixture: boolean;
  server?: string;
  concurrency?: number;
  now?: () => Date;
  log?: NaipLog;
}

/** Download (or resume) a run; returns its directory and index. */
export async function fetchRun(o: FetchRunOptions): Promise<{ dir: string; index: RunIndex }> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const server = o.server ?? NAIP_IMAGE_SERVER;
  const tiles = tilesForArea(o.aoi.area, o.minzoom, o.maxzoom);
  if (tiles.length === 0) throw new Error('the area of interest covers no tiles');
  if (tiles.length > o.maxTiles) {
    throw new Error(
      `${tiles.length} tiles at zooms ${o.minzoom}-${o.maxzoom} is over the limit of ${o.maxTiles}: lower --maxzoom or raise --max-tiles`,
    );
  }
  const root = rawRoot(o.projectDir);
  const box = turfBbox(o.aoi.area) as [number, number, number, number];
  const want = {
    format: 1 as const,
    source: NAIP_SOURCE as typeof NAIP_SOURCE,
    service: server,
    fixture: o.fixture,
    aoiSha256: o.aoi.sha256,
    bbox: box,
    minzoom: o.minzoom,
    maxzoom: o.maxzoom,
  };
  const resumable = await findRun(root, RUN_PARTIAL_FILE, (t) => {
    const p = runParamsSchema.safeParse(JSON.parse(t));
    return p.success && sameParams(p.data, want) ? p.data : null;
  });
  let dir: string;
  let params: RunParams;
  if (resumable && !(await exists(path.join(resumable.dir, RUN_INDEX_FILE)))) {
    dir = resumable.dir;
    params = resumable.value;
    log(`resuming ${rawRelative(root, dir)}`);
  } else {
    dir = await newRunDir(root, NAIP_SOURCE, now());
    params = { ...want, startedAt: now().toISOString() };
    await writeFileAtomic(path.join(dir, RUN_PARTIAL_FILE), `${JSON.stringify(params, null, 2)}\n`);
  }
  log(`${tiles.length} tiles at zooms ${o.minzoom}-${o.maxzoom} for ${o.aoi.from}`);

  const results: RunIndex['tiles'] = new Array(tiles.length);
  let next = 0;
  let done = 0;
  let fetched = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tiles.length) return;
      const t = tiles[i] as TileCoord;
      const file = path.join(dir, 'tiles', ...tilePath(t).split('/'));
      const cached: Uint8Array | null = await readFile(file).catch(() => null);
      let bytes: Uint8Array;
      if (cached && isJpeg(cached)) bytes = cached;
      else {
        bytes = await fetchTile(t, server, o.fetch);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
        fetched += 1;
      }
      results[i] = { ...t, bytes: bytes.length, sha256: sha256Hex(bytes) };
      done += 1;
      if (done % 500 === 0) log(`${done}/${tiles.length} tiles`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  const index: RunIndex = {
    ...params,
    finishedAt: now().toISOString(),
    complete: true,
    bytes: results.reduce((s, t) => s + t.bytes, 0),
    tiles: results,
  };
  const text = `${JSON.stringify(index)}\n`;
  await writeFileAtomic(path.join(dir, RUN_INDEX_FILE), text);
  await recordDownloads(root, [
    {
      source: NAIP_SOURCE,
      path: rawRelative(root, path.join(dir, RUN_INDEX_FILE)),
      url: o.fixture ? `fixture:${naipOnlineTemplate(server)}` : naipOnlineTemplate(server),
      method: 'GET',
      requestSha256: null,
      fetchedAt: index.finishedAt,
      sha256: sha256Hex(text),
      bytes: index.bytes,
      licence: o.fixture ? 'Synthetic fixture tiles (not NAIP imagery)' : NAIP_LICENCE,
    },
  ]);
  log(
    `${fetched} tiles downloaded, ${tiles.length - fetched} reused; ${(index.bytes / 1e6).toFixed(1)} MB`,
  );
  return { dir, index };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function fetchTile(t: TileCoord, server: string, f: FetchLike): Promise<Buffer> {
  const url = naipExportUrl(t, server);
  const res = await fetchWithRetry(url, {}, { fetch: f, timeoutMs: 60_000 });
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !isJpeg(body)) {
    const hint = body.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(
      `exportImage ${t.z}/${t.x}/${t.y} → HTTP ${res.status} ${res.headers.get('content-type') ?? ''}, not a JPEG (${hint})`,
    );
  }
  return body;
}

/** The newest complete run (for --offline): every tile checked against its sha256. */
export async function newestCompleteRun(
  projectDir: string,
): Promise<{ dir: string; index: RunIndex }> {
  const found = await findRun(rawRoot(projectDir), RUN_INDEX_FILE, (t) => {
    const p = runIndexSchema.safeParse(JSON.parse(t));
    return p.success ? p.data : null;
  });
  if (!found)
    throw new Error('no complete NAIP run in data/raw/naip: run pnpm gis:naip with internet first');
  return { dir: found.dir, index: found.value };
}

// ---------------------------------------------------------------------------------------------
// 4. the archive
// ---------------------------------------------------------------------------------------------

export async function buildArchive(
  dir: string,
  index: RunIndex,
  vintage: string,
): Promise<{ archive: Buffer; sha256: string }> {
  const tiles = [];
  for (const t of index.tiles) {
    const data = await readFile(path.join(dir, 'tiles', ...tilePath(t).split('/')));
    if (sha256Hex(data) !== t.sha256) {
      throw new Error(`data/raw tile ${tilePath(t)} changed since it was downloaded (checksum)`);
    }
    tiles.push({ z: t.z, x: t.x, y: t.y, data });
  }
  const [w, s, e, n] = index.bbox;
  const archive = writePmtiles(tiles, {
    tileType: PmTileType.Jpeg,
    tileCompression: PmCompression.None,
    bounds: [w, s, e, n],
    center: [(w + e) / 2, (s + n) / 2, Math.min(index.maxzoom, index.minzoom + 2)],
    metadata: {
      name: 'NAIP close-ups (area of interest)',
      attribution: NAIP_ATTRIBUTION,
      vintage,
      service: index.service,
      fixture: index.fixture,
      aoiSha256: index.aoiSha256,
      fetchedAt: index.finishedAt,
    },
  });
  return { archive, sha256: createHash('sha256').update(archive).digest('hex') };
}

// ---------------------------------------------------------------------------------------------
// 5. storage + registry
// ---------------------------------------------------------------------------------------------

export interface InstallResult {
  key: string;
  version: string;
  bytes: number;
  replaced: string | null;
}

export async function installAoiArchive(
  pool: pg.Pool,
  writer: StorageWriter,
  archive: Buffer,
  sha256: string,
  index: RunIndex,
  vintage: string,
): Promise<InstallResult> {
  const key = `naip/${contentAddressedName('aoi', sha256, 'pmtiles')}`;
  const info = await writer.put('tiles', key, archive, { contentType: 'application/vnd.pmtiles' });
  const version = sha256.slice(0, 8);
  const c = await pool.connect();
  let previous: string | null = null;
  try {
    await c.query('begin');
    const prev = await c.query<{ url_or_key: string }>(
      `select url_or_key from gis.map_layers where key = 'naip_aoi' for update`,
    );
    previous = prev.rows[0]?.url_or_key ?? null;
    await c.query(
      `insert into gis.map_layers (key, kind, url_or_key, version, cache_policy, minzoom, maxzoom,
                                   attribution, legend, source_vintage, built_at, default_visible, meta)
       values ('naip_aoi', 'pmtiles', $1, $2, 'public', $3, $4, $5, $6::jsonb, $7, now(), false, $8::jsonb)
       on conflict (key) do update
          set kind = excluded.kind, url_or_key = excluded.url_or_key, version = excluded.version,
              cache_policy = excluded.cache_policy, minzoom = excluded.minzoom,
              maxzoom = excluded.maxzoom, attribution = excluded.attribution,
              legend = excluded.legend, source_vintage = excluded.source_vintage,
              built_at = excluded.built_at, meta = excluded.meta, updated_at = now()`,
      [
        key,
        version,
        index.minzoom,
        index.maxzoom,
        NAIP_ATTRIBUTION,
        index.fixture
          ? JSON.stringify({
              items: [{ label: 'Synthetic fixture tiles', swatch: 'fill', color: '#7c9a5c' }],
              note: 'Not NAIP imagery: run pnpm gis:naip on a PC with internet',
            })
          : null,
        vintage,
        JSON.stringify({
          bounds: index.bbox,
          tileType: 'jpg',
          tiles: index.tiles.length,
          bytes: info.size,
          fixture: index.fixture,
          aoiSha256: index.aoiSha256,
        }),
      ],
    );
    await publish('layers', 'updated', { key: 'naip_aoi', version }, c);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  // Only now that the registry points at the new archive may the old one go (plan §1).
  let replaced: string | null = null;
  if (previous && previous !== key && previous.startsWith('naip/')) {
    try {
      if (await writer.delete('tiles', previous)) replaced = previous;
    } catch (e) {
      // Not fatal: an orphaned old archive costs disk only.
      console.warn(`[gis:naip] could not delete ${previous}: ${describeError(e)}`);
    }
  }
  return { key, version, bytes: info.size, replaced };
}
