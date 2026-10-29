/**
 * Vector inputs for the 1d importers (`pnpm gis:parcels <file>`, `pnpm import:tile <file>`):
 * any of these becomes a list of GeoJSON features in WGS84.
 *
 *  - GeoJSON (.geojson / .json): a FeatureCollection, a Feature or a bare geometry (RFC 7946,
 *    WGS84).
 *  - Shapefile: a .zip (one or more .shp inside) or a .shp with its .dbf / .prj / .cpg next to it.
 *    shpjs reprojects to WGS84 with the .prj (proj4); without one, projected coordinates fail
 *    the longitude/latitude check (`checkLngLat`) instead of landing in the ocean.
 *  - GeoPackage (.gpkg) and anything else GDAL reads: `ogr2ogr -f GeoJSON -t_srs EPSG:4326` in
 *    the pinned GDAL container (docs/contracts-m1.md §13), written to a temp directory.
 *  - An ArcGIS FeatureServer / MapServer layer URL (`https://…/FeatureServer/0`): paged
 *    `query?where=1=1&outFields=*&outSR=4326&f=geojson&orderByFields=<objectIdField>` with
 *    `resultOffset` / `resultRecordCount`, continuing while the reply says
 *    `exceededTransferLimit` (Esri: "always rely on exceededTransferLimit to determine if you
 *    should page", https://developers.arcgis.com/rest/services-reference/enterprise/query-map-service-layer/).
 *    The layer must report `advancedQueryCapabilities.supportsPagination`.
 *
 * Generic on purpose (parcels and tile lines share it; the integrator may move it next to the
 * boundary importer's reader in tools/import/). CLI-only: never imported by app code.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Feature, Geometry, Position } from 'geojson';
import shp from 'shpjs';
import { type RunOptions, type RunResult, run as runProcess } from '../../src/lib/proc';
import { describeError, type FetchLike, fetchWithRetry } from './http';

/** The pinned GDAL image (docs/contracts-m1.md §13). */
export const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:ubuntu-small-3.13.3';

export interface VectorFeature {
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  /** Layer (shapefile name inside a zip, file name, service layer). */
  layer: string;
}

export interface VectorSource {
  /** File name or URL (for messages and gis.parcel_imports.file_name). */
  name: string;
  /** sha256 of the input bytes (a shapefile set: of its parts in a fixed order). */
  sha256: string;
  bytes: number;
  features: VectorFeature[];
  /** The raw GeoJSON text of a downloaded service (to keep in data/raw), else null. */
  downloaded: string | null;
}

export class VectorInputError extends Error {
  override name = 'VectorInputError';
}

export type Runner = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export interface ReadOptions {
  fetch?: FetchLike;
  run?: Runner;
  log?: (msg: string) => void;
  /** Features per FeatureServer page (default: the layer's maxRecordCount, capped at 2000). */
  pageSize?: number;
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

const ext = (name: string) => path.extname(name).slice(1).toLowerCase();

function asFeatures(value: unknown, layer: string, name: string): VectorFeature[] {
  const v = value as { type?: unknown };
  if (!v || typeof v !== 'object' || typeof v.type !== 'string') {
    throw new VectorInputError(`${name}: not GeoJSON (no "type")`);
  }
  if (v.type === 'FeatureCollection') {
    const fs = (value as { features?: unknown }).features;
    if (!Array.isArray(fs))
      throw new VectorInputError(`${name}: FeatureCollection without features`);
    return fs.map((f) => asFeature(f, layer, name));
  }
  if (v.type === 'Feature') return [asFeature(value, layer, name)];
  return [{ geometry: value as Geometry, properties: {}, layer }];
}

function asFeature(f: unknown, layer: string, name: string): VectorFeature {
  const feat = f as Partial<Feature>;
  if (feat?.type !== 'Feature') {
    throw new VectorInputError(`${name}: an entry is not a Feature`);
  }
  return {
    geometry: (feat.geometry ?? null) as Geometry | null,
    properties: (feat.properties ?? {}) as Record<string, unknown>,
    layer,
  };
}

/** Parse GeoJSON text (a FeatureCollection, a Feature or a bare geometry). */
export function parseGeoJsonText(text: string, name: string): VectorFeature[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new VectorInputError(`${name}: not valid JSON (${(e as Error).message})`);
  }
  return asFeatures(value, path.basename(name).replace(/\.[^.]+$/, ''), name);
}

/** A zipped shapefile (one or more .shp inside). */
export async function readShapefileZip(bytes: Uint8Array, name: string): Promise<VectorFeature[]> {
  let out: Awaited<ReturnType<typeof shp>>;
  try {
    out = await shp(bytes);
  } catch (e) {
    throw new VectorInputError(`${name}: could not read the zip (${(e as Error).message})`);
  }
  const layers = Array.isArray(out) ? out : [out];
  return layers.flatMap((l) =>
    l.features.map((f) => ({
      geometry: f.geometry,
      properties: f.properties ?? {},
      layer: l.fileName ?? path.basename(name, '.zip'),
    })),
  );
}

/** A .shp plus whichever of .dbf / .prj / .cpg sit next to it (same base name, any case). */
export async function readShapefileSet(
  shpPath: string,
): Promise<{ features: VectorFeature[]; sha256: string; bytes: number }> {
  const base = shpPath.slice(0, -path.extname(shpPath).length);
  const sidecar = async (e: string) => {
    for (const candidate of [`${base}.${e}`, `${base}.${e.toUpperCase()}`]) {
      const buf = await readFile(candidate).catch(() => null);
      if (buf) return buf;
    }
    return null;
  };
  const main = await readFile(shpPath);
  const [dbf, prj, cpg] = await Promise.all([sidecar('dbf'), sidecar('prj'), sidecar('cpg')]);
  let fc: Awaited<ReturnType<typeof shp>>;
  try {
    fc = await shp({
      shp: main,
      dbf: dbf ?? undefined,
      prj: prj ? prj.toString('utf8') : undefined,
      cpg: cpg ? cpg.toString('utf8') : undefined,
    });
  } catch (e) {
    throw new VectorInputError(
      `${shpPath}: could not read the shapefile (${(e as Error).message})`,
    );
  }
  if (Array.isArray(fc)) throw new VectorInputError(`${shpPath}: unexpected several layers`);
  const parts = [main, dbf, prj, cpg].filter((b) => b !== null);
  return {
    features: fc.features.map((f) => ({
      geometry: f.geometry,
      properties: f.properties ?? {},
      layer: path.basename(base),
    })),
    sha256: sha256(...parts),
    bytes: parts.reduce((n, b) => n + b.length, 0),
  };
}

/** `docker run` arguments converting `file` (in `inDir`) to GeoJSON in `outDir`. */
export function ogr2ogrArgs(inDir: string, file: string, outDir: string, layer?: string): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${inDir}:/in:ro`,
    '-v',
    `${outDir}:/out`,
    GDAL_IMAGE,
    'ogr2ogr',
    '-f',
    'GeoJSON',
    '-t_srs',
    'EPSG:4326',
    '-lco',
    'RFC7946=YES',
    '/out/out.geojson',
    `/in/${file}`,
    ...(layer ? [layer] : []),
  ];
}

/** Any GDAL-readable file (GeoPackage, File Geodatabase zip, …) through ogr2ogr in Docker. */
export async function readWithGdal(
  file: string,
  opts: { run?: Runner; layer?: string } = {},
): Promise<VectorFeature[]> {
  const run = opts.run ?? runProcess;
  const out = await mkdtemp(path.join(tmpdir(), 'farm-ogr-'));
  try {
    const r = await run(
      'docker',
      ogr2ogrArgs(path.dirname(path.resolve(file)), path.basename(file), out, opts.layer),
      {
        timeoutMs: 30 * 60_000,
      },
    );
    if (r.code !== 0) {
      throw new VectorInputError(
        `ogr2ogr (${GDAL_IMAGE}) failed for ${file}: ${(r.stderr || r.stdout).trim().slice(0, 500)}. Is Docker running?`,
      );
    }
    const text = await readFile(path.join(out, 'out.geojson'), 'utf8');
    return parseGeoJsonText(text, file).map((f) => ({
      ...f,
      layer: opts.layer ?? path.basename(file),
    }));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

interface LayerInfo {
  objectIdField?: string;
  maxRecordCount?: number;
  advancedQueryCapabilities?: { supportsPagination?: boolean };
  name?: string;
  error?: { message?: string };
}

/** Is this an ArcGIS REST layer URL (…/FeatureServer/<n> or …/MapServer/<n>)? */
export function isArcGisLayerUrl(input: string): boolean {
  return /^https?:\/\/.+\/(FeatureServer|MapServer)\/\d+\/?(\?.*)?$/i.test(input);
}

/** The query URL of one page. */
export function featureServerPageUrl(
  layerUrl: string,
  objectIdField: string,
  offset: number,
  count: number,
): string {
  const base = layerUrl.replace(/\?.*$/, '').replace(/\/$/, '');
  const q = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: objectIdField,
    resultOffset: String(offset),
    resultRecordCount: String(count),
    f: 'geojson',
  });
  return `${base}/query?${q.toString()}`;
}

/** Does a GeoJSON page say more remain? (Esri puts the flag at the top or under `properties`.) */
export function pageExceeded(page: Record<string, unknown>): boolean {
  const props = page.properties as Record<string, unknown> | undefined;
  return page.exceededTransferLimit === true || props?.exceededTransferLimit === true;
}

/** Every feature of an ArcGIS FeatureServer / MapServer layer, page by page. */
export async function fetchFeatureServer(
  layerUrl: string,
  opts: ReadOptions = {},
): Promise<{ features: VectorFeature[]; text: string; pages: number }> {
  const get = async (url: string): Promise<Record<string, unknown>> => {
    const res = await fetchWithRetry(url, {}, { fetch: opts.fetch, timeoutMs: 120_000 });
    if (!res.ok) throw new VectorInputError(`GET ${url} → HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as { message?: string } | undefined;
    if (err) throw new VectorInputError(`${url}: ${err.message ?? 'service error'}`);
    return body;
  };
  const base = layerUrl.replace(/\?.*$/, '').replace(/\/$/, '');
  const info = (await get(`${base}?f=json`)) as LayerInfo;
  if (!info.advancedQueryCapabilities?.supportsPagination) {
    throw new VectorInputError(
      `${base} does not support paging (advancedQueryCapabilities.supportsPagination); convert it with ogr2ogr (GDAL's ESRIJSON driver pages by itself) and import the file`,
    );
  }
  const oid = info.objectIdField ?? 'OBJECTID';
  const size = Math.max(1, Math.min(opts.pageSize ?? info.maxRecordCount ?? 1000, 2000));
  const layer = info.name ?? base;
  const features: Feature[] = [];
  let pages = 0;
  for (let offset = 0; ; ) {
    if (pages >= 10_000) throw new VectorInputError(`${base}: more than 10000 pages; stopping`);
    const page = await get(featureServerPageUrl(base, oid, offset, size));
    pages += 1;
    const fs = Array.isArray(page.features) ? (page.features as Feature[]) : [];
    features.push(...fs);
    opts.log?.(`page ${pages}: ${fs.length} features (${features.length} so far)`);
    offset += fs.length;
    // Esri: keep paging while exceededTransferLimit is returned (a page can even be empty).
    if (!pageExceeded(page)) break;
    if (fs.length === 0) offset += size;
  }
  const text = JSON.stringify({ type: 'FeatureCollection', features });
  return {
    features: features.map((f) => asFeature(f, layer, base)),
    text,
    pages,
  };
}

/** Read any supported input (a path or a service URL). Throws VectorInputError with a fix-it. */
export async function readVectorInput(
  input: string,
  opts: ReadOptions = {},
): Promise<VectorSource> {
  if (/^https?:\/\//i.test(input)) {
    if (!isArcGisLayerUrl(input)) {
      throw new VectorInputError(
        `${input}: only ArcGIS layer URLs (…/FeatureServer/<n> or …/MapServer/<n>) can be read; download other files first`,
      );
    }
    try {
      const r = await fetchFeatureServer(input, opts);
      const bytes = Buffer.from(r.text);
      return {
        name: input,
        sha256: sha256(bytes),
        bytes: bytes.length,
        features: r.features,
        downloaded: r.text,
      };
    } catch (e) {
      if (e instanceof VectorInputError) throw e;
      throw new VectorInputError(`${input}: ${describeError(e)}`);
    }
  }
  const s = await stat(input).catch(() => null);
  if (!s?.isFile()) throw new VectorInputError(`${input}: no such file`);
  const kind = ext(input);
  if (kind === 'shp') {
    const r = await readShapefileSet(input);
    return { name: path.basename(input), ...r, downloaded: null };
  }
  const bytes = await readFile(input);
  const base = {
    name: path.basename(input),
    sha256: sha256(bytes),
    bytes: bytes.length,
    downloaded: null,
  };
  if (kind === 'geojson' || kind === 'json') {
    return { ...base, features: parseGeoJsonText(bytes.toString('utf8'), input) };
  }
  if (kind === 'zip') return { ...base, features: await readShapefileZip(bytes, input) };
  if (kind === 'gpkg' || kind === 'gdb' || kind === 'kml' || kind === 'gml') {
    return { ...base, features: await readWithGdal(input, { run: opts.run }) };
  }
  throw new VectorInputError(
    `${input}: unsupported file type '.${kind}'. Give a .geojson, a zipped shapefile (.zip), a .shp with its .dbf/.prj, a .gpkg, or an ArcGIS layer URL`,
  );
}

/** Every position of a geometry. */
export function* positions(g: Geometry): Generator<Position> {
  switch (g.type) {
    case 'Point':
      yield g.coordinates;
      return;
    case 'MultiPoint':
    case 'LineString':
      yield* g.coordinates;
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const r of g.coordinates) yield* r;
      return;
    case 'MultiPolygon':
      for (const p of g.coordinates) for (const r of p) yield* r;
      return;
    case 'GeometryCollection':
      for (const x of g.geometries) yield* positions(x);
      return;
  }
}

/**
 * Null when every coordinate is a finite WGS84 longitude/latitude, else why not (projected
 * coordinates from a shapefile without its .prj are the usual cause).
 */
export function checkLngLat(g: Geometry): string | null {
  for (const p of positions(g)) {
    const [x, y] = p;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return 'a coordinate is not a number';
    }
    if (x < -180 || x > 180 || y < -90 || y > 90) {
      return `coordinate (${x}, ${y}) is not a longitude/latitude: is the .prj missing, or the file in another projection?`;
    }
  }
  return null;
}
