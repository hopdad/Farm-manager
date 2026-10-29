/**
 * Boundary files -> IncomingBoundary[] (plan 1c `import:boundaries`, docs/contracts-m1.md §13).
 * Pure: bytes in, GeoJSON out, no database and no filesystem, so the CLI
 * (scripts/import-boundaries.ts) and the admin upload (/admin/fields) read files the same way.
 *
 * Accepted:
 *  - a zipped shapefile (an Operations Center boundary export is a .zip of .shp/.dbf/.prj/...;
 *    several shapefiles in one zip, in folders, are fine);
 *  - an unzipped shapefile set: the .shp plus its .dbf, .prj and .cpg (.shx is not needed);
 *  - GeoJSON (.geojson / .json): a FeatureCollection, a Feature or a bare geometry, WGS84
 *    (RFC 7946).
 *
 * Shapefiles are reprojected to WGS84 by shpjs with their .prj (proj4). A missing or unreadable
 * .prj leaves projected coordinates (metres or feet) behind: they fail the longitude/latitude
 * check below instead of landing somewhere in the ocean. Zips are unpacked under limits
 * (./zip-vectors.ts: 64 MB and 2000 entries for an upload, so a zip bomb can't take the server
 * down), and a .dbf without a .cpg is decoded as UTF-8 only when it is valid UTF-8, else as
 * Windows-1252 (what a .dbf without a .cpg is on Windows), so accented names arrive intact.
 *
 * Attribute names: the exact column names of an Ops Center export were NOT confirmed from
 * Deere documentation when this was written (developer.deere.com and the third-party guides
 * that describe the export were unreachable from the build machine), so the reader looks for
 * the usual spellings (FIELD_NAME, FIELD, NAME, ...; .dbf names are cut at 10 characters, so
 * CLIENT_NAME arrives as CLIENT_NAM) and every one can be named explicitly (`nameAttr`,
 * `farmAttr`, `clientAttr`, `idAttr`; CLI `--name-attr` ...). A feature without a name
 * attribute takes its shapefile's name (or the folder's, for generic file names like
 * "Boundary"), as exports with one shapefile per field are laid out.
 *
 * Features of one field (same Deere id, or same farm + name) are combined into one
 * MultiPolygon; the database makes it valid and unions it on write.
 */
import type { Feature, Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import type { IncomingBoundary } from '../../src/db/queries/boundaries';
import { BASEMAP_BBOX } from '../../src/platform/storage/basemap';
import {
  parseShapefileParts,
  UPLOAD_ZIP_LIMITS,
  unzipVectors,
  type ZipLimits,
  type ZippedVectors,
  ZipReadError,
} from './zip-vectors';

export interface InputFile {
  /** File name (extension decides how it is read); paths inside are kept for messages. */
  name: string;
  bytes: Uint8Array;
}

export interface ParsedLayer {
  /** Shapefile path inside the zip without extension, or the GeoJSON file name. */
  fileName: string;
  features: Feature<Geometry | null, Record<string, unknown> | null>[];
}

export interface AttributeOptions {
  /** Column holding the field name (default: detected). */
  nameAttr?: string;
  farmAttr?: string;
  clientAttr?: string;
  /** Column holding the John Deere field id (default: detected; only explicit Deere names). */
  idAttr?: string;
}

export interface ExtractResult {
  boundaries: IncomingBoundary[];
  /** Problems that stop the import (a feature that can't be read is never silently dropped). */
  errors: string[];
  warnings: string[];
  /** Every attribute name seen, for "which column is the name?" messages. */
  attributes: string[];
  featureCount: number;
}

export class BoundaryFileError extends Error {
  override name = 'BoundaryFileError';
}

const lower = (s: string) => s.toLowerCase();
const ext = (name: string) => {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? lower(m[1] as string) : '';
};
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stripExt = (p: string) => p.replace(/\.[^./\\]+$/, '');

const SHAPEFILE_PARTS = new Set(['shp', 'shx', 'dbf', 'prj', 'cpg', 'sbn', 'sbx', 'xml']);

/**
 * Read the uploaded/named files into layers. Throws BoundaryFileError with a fix-it message.
 * `zipLimits`: what a zip may unpack to (default: an admin upload's).
 */
export async function readBoundaryFiles(
  files: readonly InputFile[],
  zipLimits: ZipLimits = UPLOAD_ZIP_LIMITS,
): Promise<ParsedLayer[]> {
  if (files.length === 0) throw new BoundaryFileError('no file given');
  const kinds = new Set(files.map((f) => ext(f.name)));
  if (files.length === 1 && kinds.has('zip')) return readZip(files[0] as InputFile, zipLimits);
  if (files.length === 1 && (kinds.has('geojson') || kinds.has('json'))) {
    return [readGeoJson(files[0] as InputFile)];
  }
  if ([...kinds].every((k) => SHAPEFILE_PARTS.has(k))) return [await readShapefileSet(files)];
  throw new BoundaryFileError(
    `unsupported file(s): ${files.map((f) => f.name).join(', ')}. Give a .zip (Operations Center export), a .shp with its .dbf/.prj, or a .geojson file`,
  );
}

async function readZip(file: InputFile, limits: ZipLimits): Promise<ParsedLayer[]> {
  let zipped: ZippedVectors;
  try {
    zipped = await unzipVectors(file.bytes, limits);
  } catch (e) {
    if (e instanceof ZipReadError && e.reason !== 'unreadable') {
      const upload = limits.maxUnzippedBytes <= UPLOAD_ZIP_LIMITS.maxUnzippedBytes;
      throw new BoundaryFileError(
        `${file.name}: ${e.message}; split it${upload ? ', or import it on the PC with `pnpm import:boundaries`' : ''}`,
      );
    }
    throw new BoundaryFileError(`${file.name}: could not read the zip (${(e as Error).message})`);
  }
  const layers: ParsedLayer[] = [];
  for (const s of zipped.shapefiles) {
    try {
      const fc = await parseShapefileParts(s);
      layers.push({ fileName: s.path, features: fc.features as ParsedLayer['features'] });
    } catch (e) {
      throw new BoundaryFileError(
        `${file.name}: could not read ${s.path}.shp (${(e as Error).message})`,
      );
    }
  }
  for (const j of zipped.geojson) layers.push(readGeoJson({ name: j.path, bytes: j.bytes }));
  if (!layers.length) {
    throw new BoundaryFileError(
      zipped.gdbPaths.length
        ? `${file.name}: the zip holds an Esri File Geodatabase (${zipped.gdbPaths.join(', ')}), not a shapefile: export the boundaries as a shapefile or GeoJSON`
        : `${file.name}: the zip holds no shapefile (.shp) or GeoJSON`,
    );
  }
  return layers;
}

async function readShapefileSet(files: readonly InputFile[]): Promise<ParsedLayer> {
  const by = (e: string) => files.filter((f) => ext(f.name) === e);
  const shps = by('shp');
  if (shps.length !== 1) {
    throw new BoundaryFileError(
      shps.length === 0
        ? 'a shapefile set needs its .shp file'
        : 'give one shapefile at a time (or zip them)',
    );
  }
  const main = shps[0] as InputFile;
  try {
    const fc = await parseShapefileParts({
      shp: main.bytes,
      dbf: by('dbf')[0]?.bytes,
      prj: by('prj')[0]?.bytes,
      cpg: by('cpg')[0]?.bytes,
    });
    return { fileName: stripExt(main.name), features: fc.features as ParsedLayer['features'] };
  } catch (e) {
    throw new BoundaryFileError(
      `${main.name}: could not read the shapefile (${(e as Error).message})`,
    );
  }
}

function readGeoJson(file: InputFile): ParsedLayer {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(file.bytes).replace(/^﻿/, ''));
  } catch (e) {
    throw new BoundaryFileError(`${file.name}: not valid JSON (${(e as Error).message})`);
  }
  if (!doc || typeof doc !== 'object') throw new BoundaryFileError(`${file.name}: not GeoJSON`);
  const o = doc as { type?: unknown; crs?: unknown };
  // RFC 7946 GeoJSON is WGS84; the old (2008) `crs` member may name something else.
  const crsName = (o.crs as { properties?: { name?: unknown } } | undefined)?.properties?.name;
  if (
    typeof crsName === 'string' &&
    !/CRS84|EPSG::?4326|EPSG::?4269|CRS83/i.test(crsName.replace(/\s/g, ''))
  ) {
    throw new BoundaryFileError(
      `${file.name}: coordinates are in ${crsName}; export or reproject to WGS84 (EPSG:4326) GeoJSON`,
    );
  }
  let features: ParsedLayer['features'];
  if (o.type === 'FeatureCollection') {
    const list = (doc as { features?: unknown }).features;
    if (!Array.isArray(list))
      throw new BoundaryFileError(`${file.name}: FeatureCollection without features`);
    features = list as ParsedLayer['features'];
  } else if (o.type === 'Feature') {
    features = [doc as ParsedLayer['features'][number]];
  } else if (typeof o.type === 'string' && GEOMETRY_TYPES.has(o.type)) {
    features = [{ type: 'Feature', geometry: doc as Geometry, properties: {} }];
  } else {
    throw new BoundaryFileError(
      `${file.name}: not a GeoJSON FeatureCollection, Feature or geometry`,
    );
  }
  return { fileName: stripExt(baseName(file.name)), features };
}

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

// ---------------------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------------------

/** Attribute key normalized: lower-case letters and digits only (FIELD_NAME -> fieldname). */
export const normKey = (k: string) => lower(k).replace(/[^a-z0-9]/g, '');

/** Detected spellings, best first (.dbf names are at most 10 characters). */
export const ATTRIBUTE_CANDIDATES = {
  name: ['fieldname', 'fieldnam', 'fieldnm', 'fldname', 'field', 'name', 'label', 'title'],
  farm: ['farmname', 'farmnam', 'farm', 'frmname'],
  client: ['clientname', 'clientnam', 'client', 'growername', 'growernam', 'grower', 'customer'],
  deereId: ['deerefieldid', 'deerefield', 'jdfieldid', 'deereid'],
} as const;

/** File names that say nothing about the field (exports with one shapefile per field). */
const GENERIC_FILE_NAMES = new Set([
  'boundary',
  'boundaries',
  'field',
  'fields',
  'fieldboundary',
  'fieldboundaries',
  'export',
  'doc',
  'layer',
  'shape',
  'shapefile',
  'polygon',
  'polygons',
]);

function pickKey(
  keys: readonly string[],
  explicit: string | undefined,
  candidates: readonly string[],
): string | null {
  if (explicit) {
    const want = normKey(explicit);
    return keys.find((k) => normKey(k) === want) ?? null;
  }
  for (const c of candidates) {
    const hit = keys.find((k) => normKey(k) === c);
    if (hit) return hit;
  }
  return null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Name for a feature with no name attribute: its shapefile's (or the folder's) name. */
export function nameFromFileName(fileName: string): string | null {
  const parts = fileName.split(/[\\/]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = (parts[i] as string).replace(/[_]+/g, ' ').trim();
    if (p && !GENERIC_FILE_NAMES.has(normKey(p))) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

type Rings = Position[][];

function polygonsOf(g: Geometry): Rings[] | string {
  switch (g.type) {
    case 'Polygon':
      return [g.coordinates];
    case 'MultiPolygon':
      return g.coordinates;
    case 'GeometryCollection': {
      const out: Rings[] = [];
      for (const part of g.geometries) {
        const p = polygonsOf(part);
        if (typeof p === 'string') return p;
        out.push(...p);
      }
      return out;
    }
    default:
      return `is a ${g.type}, not a polygon`;
  }
}

/** Closed rings of [lng, lat] (Z/M dropped), or a reason the feature can't be a boundary. */
function cleanPolygons(polys: Rings[]): Rings[] | string {
  const out: Rings[] = [];
  for (const poly of polys) {
    const rings: Rings = [];
    for (const ring of poly) {
      const pts: Position[] = [];
      for (const p of ring) {
        const [x, y] = p as [number, number];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          return 'has a coordinate that is not a number';
        if (x < -180 || x > 180 || y < -90 || y > 90) {
          return `has coordinates (${x}, ${y}) that are not longitude/latitude: the shapefile's .prj is missing or unreadable (export it with its .prj, or as WGS84)`;
        }
        pts.push([x, y]);
      }
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first && last && (first[0] !== last[0] || first[1] !== last[1])) pts.push([...first]);
      if (pts.length < 4) {
        if (rings.length === 0) return 'has a ring with fewer than 3 corners';
        continue; // a degenerate hole: drop it
      }
      rings.push(pts);
    }
    if (rings.length > 0) out.push(rings);
  }
  return out.length > 0 ? out : 'has no polygon area';
}

function centroidOf(polys: Rings[]): [number, number] {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const poly of polys) {
    for (const p of poly[0] ?? []) {
      x += p[0] as number;
      y += p[1] as number;
      n++;
    }
  }
  return n ? [x / n, y / n] : [0, 0];
}

/** Rough "is this near the farm" check: the basemap area padded by about 50 km. */
function nearFarm([x, y]: [number, number]): boolean {
  const [w, s, e, n] = BASEMAP_BBOX;
  return x >= w - 0.6 && x <= e + 0.6 && y >= s - 0.45 && y <= n + 0.45;
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

const normName = (s: string) => lower(s.replace(/\s+/g, ' ').trim());

interface Group {
  name: string;
  nameSource: IncomingBoundary['nameSource'];
  farmName: string | null;
  clientName: string | null;
  deereFieldId: string | null;
  polygons: Rings[];
  refs: string[];
}

/** Turn parsed layers into one IncomingBoundary per field. Never throws for bad features. */
export function extractBoundaries(
  layers: readonly ParsedLayer[],
  opts: AttributeOptions = {},
  sourceName = '',
): ExtractResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const attributes = new Set<string>();
  const groups = new Map<string, Group>();
  let featureCount = 0;
  let farAway = 0;

  for (const layer of layers) {
    const keys = new Set<string>();
    for (const f of layer.features) for (const k of Object.keys(f?.properties ?? {})) keys.add(k);
    for (const k of keys) attributes.add(k);
    const keyList = [...keys];
    const nameKey = pickKey(keyList, opts.nameAttr, ATTRIBUTE_CANDIDATES.name);
    const farmKey = pickKey(keyList, opts.farmAttr, ATTRIBUTE_CANDIDATES.farm);
    const clientKey = pickKey(keyList, opts.clientAttr, ATTRIBUTE_CANDIDATES.client);
    const idKey = pickKey(keyList, opts.idAttr, ATTRIBUTE_CANDIDATES.deereId);
    for (const [want, got] of [
      [opts.nameAttr, nameKey],
      [opts.farmAttr, farmKey],
      [opts.clientAttr, clientKey],
      [opts.idAttr, idKey],
    ] as const) {
      if (want && !got && layer.features.length > 0) {
        errors.push(
          `${layer.fileName}: no attribute '${want}' (attributes: ${keyList.join(', ') || 'none'})`,
        );
      }
    }
    const fileNameName = nameFromFileName(layer.fileName);

    layer.features.forEach((f, i) => {
      featureCount++;
      const ref = `${layer.fileName}#${i + 1}`;
      const props = f?.properties ?? {};
      let name = nameKey ? text(props[nameKey]) : null;
      let nameSource: IncomingBoundary['nameSource'] = 'attribute';
      if (!name && fileNameName) {
        name = fileNameName;
        nameSource = 'file name';
      }
      const label = name ? `${ref} (${name})` : ref;
      if (f?.type !== 'Feature') {
        errors.push(`${ref}: not a GeoJSON Feature`);
        return;
      }
      if (!f.geometry) {
        warnings.push(`${label}: no geometry, skipped`);
        return;
      }
      const polys = polygonsOf(f.geometry);
      if (typeof polys === 'string') {
        errors.push(`${label} ${polys}`);
        return;
      }
      const clean = cleanPolygons(polys);
      if (typeof clean === 'string') {
        errors.push(`${label} ${clean}`);
        return;
      }
      if (!name) {
        errors.push(
          `${ref}: no field name (attributes: ${keyList.join(', ') || 'none'}); name the column with --name-attr`,
        );
        return;
      }
      if (!nearFarm(centroidOf(clean))) farAway++;
      const farmName = farmKey ? text(props[farmKey]) : null;
      const clientName = clientKey ? text(props[clientKey]) : null;
      const deereFieldId = idKey ? text(props[idKey]) : null;
      const key = deereFieldId
        ? `id:${deereFieldId}`
        : `name:${normName(farmName ?? '')}/${normName(name)}`;
      const g = groups.get(key);
      if (g) {
        g.polygons.push(...clean);
        g.refs.push(ref);
        if (deereFieldId && normName(g.name) !== normName(name)) {
          warnings.push(`${ref}: Deere id ${deereFieldId} is also '${g.name}'; kept '${g.name}'`);
        }
      } else {
        groups.set(key, {
          name,
          nameSource,
          farmName,
          clientName,
          deereFieldId,
          polygons: clean,
          refs: [ref],
        });
      }
    });
  }

  if (farAway > 0) {
    warnings.push(
      `${farAway} feature(s) lie far from SE Michigan: check the file's coordinate system (.prj)`,
    );
  }
  const boundaries: IncomingBoundary[] = [...groups.values()].map((g) => {
    const geometry: MultiPolygon = { type: 'MultiPolygon', coordinates: g.polygons };
    return {
      name: g.name,
      nameSource: g.nameSource,
      farmName: g.farmName,
      clientName: g.clientName,
      deereFieldId: g.deereFieldId,
      geometry,
      featureCount: g.refs.length,
      sourceRef: `${sourceName ? `${sourceName}: ` : ''}${summarizeRefs(g.refs)}`,
    };
  });
  return { boundaries, errors, warnings, attributes: [...attributes], featureCount };
}

function summarizeRefs(refs: string[]): string {
  return refs.length <= 3 ? refs.join(', ') : `${refs.slice(0, 3).join(', ')} +${refs.length - 3}`;
}

/** Convenience: read + extract (the CLI and the admin upload). */
export async function parseBoundaryFiles(
  files: readonly InputFile[],
  opts: AttributeOptions = {},
  zipLimits: ZipLimits = UPLOAD_ZIP_LIMITS,
): Promise<ExtractResult> {
  const layers = await readBoundaryFiles(files, zipLimits);
  const sourceName =
    files.length === 1
      ? baseName((files[0] as InputFile).name)
      : baseName((files.find((f) => ext(f.name) === 'shp') ?? (files[0] as InputFile)).name);
  return extractBoundaries(layers, opts, sourceName);
}

/** For tests and callers that build a Polygon by hand. */
export function asMultiPolygon(g: Polygon | MultiPolygon): MultiPolygon {
  return g.type === 'MultiPolygon' ? g : { type: 'MultiPolygon', coordinates: [g.coordinates] };
}
