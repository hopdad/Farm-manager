/**
 * Parcel features → gis.parcels rows (plan 1d, D7; docs/contracts-m1.md §3.1, §5.3). Pure: no
 * database, no filesystem.
 *
 * Attribute names differ per county and vendor, so each column is looked up from a list of
 * usual spellings (case-insensitive; .dbf names are cut at 10 characters), and every one can be
 * named explicitly (`--map parcel=PIN,owner=OWNER1,…`). The candidate lists below are common
 * spellings, NOT confirmed against a Lenawee, Monroe, Regrid or ReportAll file (none had arrived
 * when this was written, D7): check the import summary's "columns used" line on the first real
 * file, and pass `--map` where it guessed wrong.
 *
 * Rules (contracts-m1 §5.3):
 *  - `parcel_no` is stored normalized (`normalizeParcelNo`), the id is `parcelId(county, no)`;
 *  - features of one file that normalize to the same (county, number) become ONE row: polygons
 *    are combined (the database unions them) and the merge is counted;
 *  - non-polygon features, features with no parcel number and empty geometries are skipped and
 *    counted (never silently); coordinates that aren't longitude/latitude stop the import.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { normalizeParcelNo, parcelId } from '../../src/domain/parcels';
import { checkLngLat, type VectorFeature } from './parcels-io';

export const PARCEL_COLUMNS = [
  'parcel',
  'owner',
  'owner2',
  'mailing',
  'mailCity',
  'mailState',
  'mailZip',
  'address',
  'acres',
  'county',
] as const;
export type ParcelColumn = (typeof PARCEL_COLUMNS)[number];

/** Usual spellings, most specific first (compared case-insensitively). */
export const PARCEL_COLUMN_CANDIDATES: Record<ParcelColumn, readonly string[]> = {
  parcel: [
    'PARCEL_NO',
    'PARCELNO',
    'PARCEL_NUM',
    'PARCELNUM',
    'PARCEL_NUMBER',
    'PARCELNUMB',
    'PARCEL_ID',
    'PARCELID',
    'PIN',
    'PIDN',
    'PID',
    'TAXPIN',
    'TAX_ID',
    'APN',
  ],
  owner: [
    'OWNER_NAME',
    'OWNERNAME',
    'OWNER_NAM',
    'OWNER1',
    'OWNER_1',
    'OWN_NAME',
    'OWNNAME',
    'TAXPAYER',
    'TAXPAYER_NAME',
    'OWNER',
  ],
  owner2: ['OWNER2', 'OWNER_2', 'OWNER_NAME2', 'OWNERNAME2'],
  mailing: [
    'MAIL_ADDR',
    'MAILADDR',
    'MAIL_ADDRESS',
    'MAILING_ADDRESS',
    'MAILING_AD',
    'MAILADD',
    'OWNER_ADDR',
    'OWNERADDR',
    'OWN_ADDR',
    'TAXPAYER_ADDR',
  ],
  mailCity: ['MAIL_CITY', 'MAILCITY', 'OWNER_CITY', 'OWN_CITY'],
  mailState: ['MAIL_STATE', 'MAILSTATE', 'MAIL_STATE2', 'OWNER_STATE', 'OWN_STATE'],
  mailZip: ['MAIL_ZIP', 'MAILZIP', 'OWNER_ZIP', 'OWN_ZIP', 'MAIL_ZIP5'],
  address: [
    'SITE_ADDR',
    'SITEADDR',
    'SITE_ADDRESS',
    'PROP_ADDR',
    'PROPADDR',
    'PROPERTY_ADDRESS',
    'PROPERTY_A',
    'SITUS',
    'SITUS_ADDR',
    'ADDRESS',
  ],
  acres: [
    'ACRES',
    'DEED_ACRES',
    'DEEDED_ACRES',
    'DEEDED_ACR',
    'ACREAGE',
    'TOTAL_ACRES',
    'TOTALACRES',
    'ASSESSED_ACRES',
    'ASSESS_ACR',
    'CALC_ACRES',
    'GIS_ACRES',
    'LL_GISACRE',
  ],
  county: ['COUNTY_FIPS', 'CNTY_FIPS', 'COUNTYFIPS', 'FIPS', 'GEOID', 'CO_FIPS'],
};

export type ColumnMap = Partial<Record<ParcelColumn, string>>;

/**
 * The entries of a `--map` value: `parcel=PIN,owner=OWNER1`. Also split where whitespace comes
 * before the next `col=`: in PowerShell (`pnpm` is pnpm.ps1 there) an unquoted
 * `parcel=PIN,owner=OWNER1` is an array, which the npm shim passes on as
 * `parcel=PIN owner=OWNER1` (Microsoft, about_Parsing, argument mode). An attribute name with a
 * space in it (`owner=Owner Name`, GeoJSON) stays whole.
 */
export function splitMapSpec(spec: string): string[] {
  return spec
    .split(/\s*,\s*|\s+(?=[A-Za-z0-9]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `--map` given as separate arguments (`--map parcel=PIN owner=OWNER1` reaches the CLI as a
 * positional `owner=OWNER1` when PowerShell splats the array): the positionals that name one of
 * `columns` (`<column>=<attribute>`) are map entries, the rest stay positionals.
 */
export function splitMapPositionals(
  positionals: readonly string[],
  columns: readonly string[],
): { map: string[]; rest: string[] } {
  const map: string[] = [];
  const rest: string[] = [];
  for (const p of positionals) {
    const key = /^([A-Za-z0-9]+)=./.exec(p)?.[1];
    if (key && columns.includes(key)) map.push(p);
    else rest.push(p);
  }
  return { map, rest };
}

/** Parse `parcel=PIN,owner=OWNER1` (the CLI's --map; see splitMapSpec). */
export function parseColumnMap(spec: string): ColumnMap {
  const out: ColumnMap = {};
  for (const part of splitMapSpec(spec)) {
    const m = /^([A-Za-z0-9]+)=(.+)$/.exec(part);
    if (!m || !(PARCEL_COLUMNS as readonly string[]).includes(m[1] as string)) {
      throw new Error(`bad --map entry '${part}' (columns: ${PARCEL_COLUMNS.join(', ')})`);
    }
    out[m[1] as ParcelColumn] = (m[2] as string).trim();
  }
  return out;
}

/** Which attribute each column comes from: explicit map first, then the first candidate seen. */
export function detectColumns(attributes: readonly string[], explicit: ColumnMap = {}): ColumnMap {
  const byUpper = new Map(attributes.map((a) => [a.toUpperCase(), a]));
  const out: ColumnMap = {};
  for (const col of PARCEL_COLUMNS) {
    const named = explicit[col];
    if (named) {
      const actual = byUpper.get(named.toUpperCase());
      if (!actual) throw new Error(`--map ${col}=${named}: the file has no attribute '${named}'`);
      out[col] = actual;
      continue;
    }
    for (const c of PARCEL_COLUMN_CANDIDATES[col]) {
      const actual = byUpper.get(c.toUpperCase());
      if (actual) {
        out[col] = actual;
        break;
      }
    }
  }
  return out;
}

export interface ParcelRecord {
  id: string;
  countyFips: string;
  /** Normalized. */
  parcelNo: string;
  ownerName: string | null;
  ownerMailing: string | null;
  propertyAddress: string | null;
  /** The file's acres (null when it has none). */
  acres: number | null;
  /** The first feature's attributes as received. */
  attrs: Record<string, unknown>;
  geometry: MultiPolygon;
  /** Features combined into this row (> 1: the database unions the polygons). */
  parts: number;
}

export interface MapResult {
  records: ParcelRecord[];
  columns: ColumnMap;
  attributes: string[];
  featureCount: number;
  skipped: { noNumber: number; notPolygon: number; noCounty: number; empty: number };
  /** Rows that took more than one feature. */
  merged: number;
  /** A few examples per problem, for the summary. */
  examples: string[];
}

export interface MapOptions {
  /** County FIPS for every feature (wins over a county column). */
  countyFips?: string;
  columns?: ColumnMap;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : null;
}

function number(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function polygons(f: VectorFeature): Polygon['coordinates'][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  if (g.type === 'GeometryCollection') {
    return g.geometries.flatMap((x) => polygons({ ...f, geometry: x }));
  }
  return [];
}

/** Join mailing parts: "123 Ashby Rd, Adrian, MI 49221". */
export function mailingAddress(
  street: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
): string | null {
  const tail = [state, zip].filter(Boolean).join(' ');
  const parts = [street, city, tail || null].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function mapParcelFeatures(
  features: readonly VectorFeature[],
  opts: MapOptions = {},
): MapResult {
  const attributes = [...new Set(features.flatMap((f) => Object.keys(f.properties)))].sort();
  const columns = detectColumns(attributes, opts.columns);
  if (opts.countyFips !== undefined && !/^\d{5}$/.test(opts.countyFips)) {
    throw new Error(
      `--county must be a 5-digit FIPS code (Lenawee 26091, Monroe 26115), not '${opts.countyFips}'`,
    );
  }
  if (!columns.parcel) {
    throw new Error(
      `no parcel number column found (looked for ${PARCEL_COLUMN_CANDIDATES.parcel.join(', ')}); the file has: ${attributes.join(', ') || '(no attributes)'}. Name it with --map parcel=<column>`,
    );
  }
  if (!opts.countyFips && !columns.county) {
    throw new Error('no county column found: pass --county 26091 (Lenawee) or 26115 (Monroe)');
  }
  const get = (f: VectorFeature, col: ParcelColumn) => {
    const name = columns[col];
    return name ? f.properties[name] : undefined;
  };

  const skipped = { noNumber: 0, notPolygon: 0, noCounty: 0, empty: 0 };
  const examples: string[] = [];
  const note = (msg: string) => {
    if (examples.length < 10) examples.push(msg);
  };
  const byKey = new Map<string, ParcelRecord>();

  features.forEach((f, idx) => {
    const raw = text(get(f, 'parcel'));
    if (!raw) {
      skipped.noNumber += 1;
      note(`feature ${idx + 1}: no parcel number`);
      return;
    }
    const parcelNo = normalizeParcelNo(raw);
    if (
      f.geometry &&
      f.geometry.type !== 'Polygon' &&
      f.geometry.type !== 'MultiPolygon' &&
      f.geometry.type !== 'GeometryCollection'
    ) {
      skipped.notPolygon += 1;
      note(`${parcelNo}: ${f.geometry.type} is not a parcel shape`);
      return;
    }
    const polys = polygons(f).filter((p) => p.length > 0 && (p[0]?.length ?? 0) >= 4);
    if (polys.length === 0) {
      skipped.empty += 1;
      note(`${parcelNo}: no polygon`);
      return;
    }
    const geometry: MultiPolygon = { type: 'MultiPolygon', coordinates: polys };
    const bad = checkLngLat(geometry);
    if (bad) throw new Error(`parcel ${parcelNo}: ${bad}`);
    const countyRaw = opts.countyFips ?? text(get(f, 'county'));
    const county = countyRaw && /^\d{5}$/.test(countyRaw) ? countyRaw : null;
    if (!county) {
      skipped.noCounty += 1;
      note(`${parcelNo}: county '${countyRaw ?? ''}' is not a 5-digit FIPS code`);
      return;
    }
    const key = `${county}|${parcelNo}`;
    const owner1 = text(get(f, 'owner'));
    const owner2 = text(get(f, 'owner2'));
    const ownerName =
      owner1 && owner2 && owner2 !== owner1 ? `${owner1} & ${owner2}` : (owner1 ?? owner2);
    const ownerMailing = mailingAddress(
      text(get(f, 'mailing')),
      text(get(f, 'mailCity')),
      text(get(f, 'mailState')),
      text(get(f, 'mailZip')),
    );
    const existing = byKey.get(key);
    if (existing) {
      existing.geometry.coordinates.push(...polys);
      existing.parts += 1;
      existing.ownerName ??= ownerName;
      existing.ownerMailing ??= ownerMailing;
      existing.propertyAddress ??= text(get(f, 'address'));
      existing.acres ??= number(get(f, 'acres'));
      return;
    }
    byKey.set(key, {
      id: parcelId(county, parcelNo),
      countyFips: county,
      parcelNo,
      ownerName,
      ownerMailing,
      propertyAddress: text(get(f, 'address')),
      acres: number(get(f, 'acres')),
      attrs: { ...f.properties },
      geometry,
      parts: 1,
    });
  });

  const records = [...byKey.values()];
  return {
    records,
    columns,
    attributes,
    featureCount: features.length,
    skipped,
    merged: records.filter((r) => r.parts > 1).length,
    examples,
  };
}
