/**
 * Tile as-built features → farm.tile_lines rows (plan 1d `import:tile <file>`). Pure.
 *
 * Inputs are installer drawings traced into GIS and tile plow logs: lines with, at best, a pipe
 * size, a depth, an install date and a kind. Attribute names vary, so each is looked up from a
 * list of usual spellings (case-insensitive; .dbf names are cut at 10 characters) and can be
 * named explicitly (`--map size=PIPE_DIA,depth=DEPTH_IN`). The lists are common spellings, NOT
 * confirmed against a Deere tile plow export or an installer's file (none had arrived when this
 * was written): check the summary's "columns used" line on the first real file.
 *
 * Units: size in inches ('4', '4 in', '4"', '6-inch'; values above 48 are taken as millimetres,
 * e.g. 100 mm → 3.9 in); depth in feet ('3.5', '3.5 ft', '42 in'; a column named *_IN or values
 * above 15 are taken as inches). Dates: YYYY-MM-DD, MM/DD/YYYY, or a year (kept in the notes, not
 * turned into a made-up day). Polygons and points are skipped and counted, never dropped silently.
 */
import type { MultiLineString } from 'geojson';
import { TILE_KINDS, type TileKind, type TileOrigin } from '../../src/db/queries/tile-lines-schema';
import { deterministicId } from '../../src/domain/ids';
import { checkLngLat, type VectorFeature } from '../gis/parcels-io';
import { splitMapSpec } from '../gis/parcels-map';

export const TILE_COLUMNS = ['size', 'depth', 'installed', 'kind', 'installer', 'notes'] as const;
export type TileColumn = (typeof TILE_COLUMNS)[number];

export const TILE_COLUMN_CANDIDATES: Record<TileColumn, readonly string[]> = {
  size: [
    'SIZE_IN',
    'SIZE',
    'TILE_SIZE',
    'TILESIZE',
    'PIPE_SIZE',
    'PIPESIZE',
    'DIAMETER',
    'DIAM',
    'DIA',
    'PIPE_DIA',
  ],
  depth: ['DEPTH_FT', 'DEPTH', 'AVG_DEPTH', 'AVGDEPTH', 'DEPTH_IN', 'TILE_DEPTH'],
  installed: [
    'INSTALLED_ON',
    'INSTALLED',
    'INSTALL_DATE',
    'INSTALL_DT',
    'INST_DATE',
    'DATE',
    'YEAR',
    'INSTALL_YR',
  ],
  kind: ['KIND', 'TYPE', 'LINE_TYPE', 'LINETYPE', 'TILE_TYPE', 'CLASS'],
  installer: ['INSTALLER', 'CONTRACTOR', 'COMPANY'],
  notes: ['NOTES', 'NOTE', 'COMMENT', 'COMMENTS', 'DESCRIPTION', 'DESC'],
};

export type TileColumnMap = Partial<Record<TileColumn, string>>;

/** Parse `size=PIPE_DIA,depth=DEPTH_IN` (the CLI's --map; see splitMapSpec for PowerShell). */
export function parseTileColumnMap(spec: string): TileColumnMap {
  const out: TileColumnMap = {};
  for (const part of splitMapSpec(spec)) {
    const m = /^([a-z]+)=(.+)$/.exec(part);
    if (!m || !(TILE_COLUMNS as readonly string[]).includes(m[1] as string)) {
      throw new Error(`bad --map entry '${part}' (columns: ${TILE_COLUMNS.join(', ')})`);
    }
    out[m[1] as TileColumn] = (m[2] as string).trim();
  }
  return out;
}

export function detectTileColumns(
  attributes: readonly string[],
  explicit: TileColumnMap = {},
): TileColumnMap {
  const byUpper = new Map(attributes.map((a) => [a.toUpperCase(), a]));
  const out: TileColumnMap = {};
  for (const col of TILE_COLUMNS) {
    const named = explicit[col];
    if (named) {
      const actual = byUpper.get(named.toUpperCase());
      if (!actual) throw new Error(`--map ${col}=${named}: the file has no attribute '${named}'`);
      out[col] = actual;
      continue;
    }
    const hit = TILE_COLUMN_CANDIDATES[col].map((c) => byUpper.get(c)).find(Boolean);
    if (hit) out[col] = hit;
  }
  return out;
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : null;
};

function leadingNumber(s: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(s.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

/** Pipe size in inches, or null. */
export function parseSizeIn(v: unknown): number | null {
  const s = text(v);
  if (!s) return null;
  const n = leadingNumber(s);
  if (n === null || n <= 0) return null;
  const mm = /mm\b/i.test(s) || n > 48;
  const inches = mm ? n / 25.4 : n;
  return inches > 0 && inches <= 120 ? Math.round(inches * 100) / 100 : null;
}

/** Depth in feet, or null. `columnInInches`: the column's name says inches (DEPTH_IN). */
export function parseDepthFt(v: unknown, columnInInches = false): number | null {
  const s = text(v);
  if (!s) return null;
  const n = leadingNumber(s);
  if (n === null || n <= 0) return null;
  const inches = columnInInches || /(in\b|"|inch)/i.test(s) || (!/ft|'|feet/i.test(s) && n > 15);
  const ft = inches ? n / 12 : n;
  return ft > 0 && ft <= 30 ? Math.round(ft * 100) / 100 : null;
}

/** An install date (YYYY-MM-DD) or, for a bare year, `{ year }` (kept in the notes). */
export function parseInstalled(v: unknown): { date: string | null; year: number | null } {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { date: v.toISOString().slice(0, 10), year: null };
  }
  const s = text(v);
  if (!s) return { date: null, year: null };
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return validDate(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{4})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    return { date: null, year: y >= 1850 && y <= 2100 ? y : null };
  }
  return { date: null, year: null };
}

function validDate(y: number, mo: number, d: number): { date: string | null; year: number | null } {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { date: null, year: null };
  }
  return { date: dt.toISOString().slice(0, 10), year: null };
}

export function parseKind(v: unknown): TileKind {
  const s = text(v)?.toLowerCase() ?? '';
  if (/sub/.test(s)) return 'submain';
  if (/main|header|trunk|outlet/.test(s)) return 'main';
  if (/lat/.test(s)) return 'lateral';
  return (TILE_KINDS as readonly string[]).includes(s) ? (s as TileKind) : 'unknown';
}

export interface TileRecord {
  id: string;
  sourceId: string;
  geometry: MultiLineString;
  kind: TileKind;
  sizeIn: number | null;
  depthFt: number | null;
  installedOn: string | null;
  installer: string | null;
  notes: string | null;
}

export interface TileMapResult {
  records: TileRecord[];
  columns: TileColumnMap;
  attributes: string[];
  featureCount: number;
  skipped: { notLine: number; empty: number };
  examples: string[];
}

export interface TileMapOptions {
  /**
   * Names the drawing (the file name): source ids are `<fileKey>#<feature id>`, the feature id
   * being its own ID / LINE_ID / FID / OBJECTID attribute, else its position in the file. So a
   * re-import of the same file changes nothing and a corrected file of the same name updates its
   * lines in place.
   */
  fileKey: string;
  columns?: TileColumnMap;
  /** Applied to features with no value of their own. */
  defaults?: {
    sizeIn?: number;
    depthFt?: number;
    installedOn?: string;
    installer?: string;
    kind?: TileKind;
  };
}

export function mapTileFeatures(
  features: readonly VectorFeature[],
  opts: TileMapOptions,
): TileMapResult {
  const attributes = [...new Set(features.flatMap((f) => Object.keys(f.properties)))].sort();
  const columns = detectTileColumns(attributes, opts.columns);
  const get = (f: VectorFeature, c: TileColumn) =>
    columns[c] ? f.properties[columns[c] as string] : undefined;
  const depthInInches = /_IN$|INCH/i.test(columns.depth ?? '');
  const skipped = { notLine: 0, empty: 0 };
  const examples: string[] = [];
  const records: TileRecord[] = [];
  const idColumn = ['ID', 'LINE_ID', 'LINEID', 'FID', 'OBJECTID']
    .map((c) => attributes.find((a) => a.toUpperCase() === c))
    .find(Boolean);
  const key = opts.fileKey.trim().toLowerCase();
  if (!key) throw new Error('fileKey is required');
  features.forEach((f, i) => {
    const g = f.geometry;
    let lines: MultiLineString['coordinates'] = [];
    if (g?.type === 'LineString') lines = [g.coordinates];
    else if (g?.type === 'MultiLineString') lines = g.coordinates;
    else if (g?.type === 'GeometryCollection') {
      lines = g.geometries.flatMap((x) =>
        x.type === 'LineString'
          ? [x.coordinates]
          : x.type === 'MultiLineString'
            ? x.coordinates
            : [],
      );
    } else if (g) {
      skipped.notLine += 1;
      if (examples.length < 10) examples.push(`feature ${i + 1}: ${g.type} is not a line`);
      return;
    }
    lines = lines
      .filter((l) => l.length >= 2)
      .map((l) => l.map((p) => [p[0] as number, p[1] as number]));
    if (lines.length === 0) {
      skipped.empty += 1;
      if (examples.length < 10) examples.push(`feature ${i + 1}: no line`);
      return;
    }
    const geometry: MultiLineString = { type: 'MultiLineString', coordinates: lines };
    const bad = checkLngLat(geometry);
    if (bad) throw new Error(`feature ${i + 1}: ${bad}`);
    const installed = parseInstalled(get(f, 'installed'));
    const notesParts = [
      text(get(f, 'notes')),
      installed.year ? `installed ${installed.year}` : null,
    ].filter(Boolean);
    const ownId = idColumn ? text(f.properties[idColumn]) : null;
    const sourceId = `${key}#${ownId ?? i + 1}`;
    const kindRaw = get(f, 'kind');
    if (records.some((r) => r.sourceId === sourceId)) {
      throw new Error(
        `two features share the id '${ownId}' (${idColumn}): fix the file or remove the column`,
      );
    }
    records.push({
      id: deterministicId('import', `tile:${sourceId}`),
      sourceId,
      geometry,
      kind:
        kindRaw === undefined || kindRaw === null
          ? (opts.defaults?.kind ?? 'unknown')
          : parseKind(kindRaw),
      sizeIn: parseSizeIn(get(f, 'size')) ?? opts.defaults?.sizeIn ?? null,
      depthFt: parseDepthFt(get(f, 'depth'), depthInInches) ?? opts.defaults?.depthFt ?? null,
      installedOn: installed.date ?? opts.defaults?.installedOn ?? null,
      installer: text(get(f, 'installer')) ?? opts.defaults?.installer ?? null,
      notes: notesParts.length > 0 ? notesParts.join('; ').slice(0, 2000) : null,
    });
  });
  return { records, columns, attributes, featureCount: features.length, skipped, examples };
}

/** Origins `import:tile` accepts (`manual` is the draw tool's). */
export const IMPORT_ORIGINS: readonly TileOrigin[] = ['installer_drawing', 'deere_tile_plow'];
