/**
 * PostGIS geometry columns for Drizzle (EPSG:4326, GeoJSON in and out).
 *
 * Drizzle's built-in `geometry` type covers points only, so every geometry column uses
 * `geometryColumn(name, 'MultiPolygon' | 'Polygon' | 'Point' | 'LineString' | 'Geometry')`:
 *  - writes: the GeoJSON value is sent as text and wrapped in
 *    `extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($1), 4326)` (see `geomFromGeoJson`);
 *    Polygon -> MultiPolygon is promoted with ST_Multi for MultiPolygon columns.
 *  - reads: Postgres returns hex EWKB; `parseEwkbHex` turns it into a GeoJSON object, so plain
 *    `db.select().from(table)` returns GeoJSON. For big or simplified reads use
 *    `asGeoJson(column, { maxDecimals, simplifyTolerance })` (ST_AsGeoJSON) in the select list.
 *
 * PostGIS lives in schema `extensions` (never `public`); SQL here is schema-qualified so it
 * doesn't depend on search_path.
 */

import { type AnyColumn, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';
import type {
  Geometry,
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';

export const SRID = 4326;

/** `Geometry` (1f, farm.pins): any type, constrained by the table's CHECK instead. */
export type GeometryKind =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'MultiLineString'
  | 'Geometry';
type GeometryOf<K extends GeometryKind> = K extends 'Point'
  ? Point
  : K extends 'LineString'
    ? LineString
    : K extends 'Polygon'
      ? Polygon
      : K extends 'MultiPolygon'
        ? MultiPolygon
        : K extends 'MultiLineString'
          ? MultiLineString
          : Geometry;

/** SQL that builds an EPSG:4326 geometry from a GeoJSON value (object or JSON text). */
export function geomFromGeoJson(value: Geometry | string): SQL {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return sql`extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(${json}::text), ${sql.raw(String(SRID))})`;
}

/** Same as geomFromGeoJson, promoted to Multi* (for MultiPolygon / MultiLineString columns). */
export function multiGeomFromGeoJson(value: Geometry | string): SQL {
  return sql`extensions.ST_Multi(${geomFromGeoJson(value)})`;
}

export interface AsGeoJsonOptions {
  /** Coordinate decimals (default 7, ~1 cm). */
  maxDecimals?: number;
  /** ST_SimplifyPreserveTopology tolerance in degrees (e.g. 0.00001 ~ 1 m). */
  simplifyTolerance?: number;
}

/** Select-list helper: the column as a parsed GeoJSON object (ST_AsGeoJSON ... ::json). */
export function asGeoJson<T extends Geometry = Geometry>(
  column: AnyColumn | SQLWrapper,
  opts: AsGeoJsonOptions = {},
): SQL<T> {
  const decimals = Math.max(0, Math.min(15, Math.trunc(opts.maxDecimals ?? 7)));
  const geom =
    opts.simplifyTolerance != null
      ? sql`extensions.ST_SimplifyPreserveTopology(${column}, ${opts.simplifyTolerance}::float8)`
      : sql`${column}`;
  return sql<T>`extensions.ST_AsGeoJSON(${geom}, ${sql.raw(String(decimals))})::json`;
}

/** `geometry(<Kind>, 4326)` column that reads and writes GeoJSON. */
export function geometryColumn<K extends GeometryKind>(name: string, kind: K) {
  const promote = kind === 'MultiPolygon' || kind === 'MultiLineString';
  return customType<{ data: GeometryOf<K>; driverData: string }>({
    dataType() {
      return `geometry(${kind},${SRID})`;
    },
    toDriver(value) {
      return promote ? multiGeomFromGeoJson(value) : geomFromGeoJson(value);
    },
    fromDriver(value) {
      return parseEwkbHex(value) as GeometryOf<K>;
    },
  })(name);
}

// ---------------------------------------------------------------------------------------------
// (E)WKB hex -> GeoJSON. Handles 2D/Z/M/ZM, both byte orders, all seven geometry types.
// Z is kept as the third coordinate; M is dropped (GeoJSON has no M).
// ---------------------------------------------------------------------------------------------

const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

class WkbReader {
  private offset = 0;
  private readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  u32(le: boolean): number {
    const v = this.view.getUint32(this.offset, le);
    this.offset += 4;
    return v;
  }
  f64(le: boolean): number {
    const v = this.view.getFloat64(this.offset, le);
    this.offset += 8;
    return v;
  }
  get done(): boolean {
    return this.offset >= this.view.byteLength;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('geometry value is not hex WKB');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readGeometry(r: WkbReader): Geometry {
  const le = r.u8() === 1;
  let type = r.u32(le);
  let hasZ = (type & EWKB_Z) !== 0;
  let hasM = (type & EWKB_M) !== 0;
  if (type & EWKB_SRID) r.u32(le); // SRID: always 4326 for our columns
  type &= 0x0fffffff;
  // ISO WKB encodes Z/M as +1000/+2000/+3000
  if (type >= 1000) {
    const dims = Math.floor(type / 1000);
    type %= 1000;
    hasZ = hasZ || dims === 1 || dims === 3;
    hasM = hasM || dims === 2 || dims === 3;
  }
  const pos = (): Position => {
    const x = r.f64(le);
    const y = r.f64(le);
    const z = hasZ ? r.f64(le) : undefined;
    if (hasM) r.f64(le);
    return z === undefined ? [x, y] : [x, y, z];
  };
  const ring = (): Position[] => {
    const n = r.u32(le);
    const pts: Position[] = [];
    for (let i = 0; i < n; i++) pts.push(pos());
    return pts;
  };
  const rings = (): Position[][] => {
    const n = r.u32(le);
    const out: Position[][] = [];
    for (let i = 0; i < n; i++) out.push(ring());
    return out;
  };
  const many = <T extends Geometry>(): T[] => {
    const n = r.u32(le);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(readGeometry(r) as T);
    return out;
  };
  switch (type) {
    case 1: {
      const p = pos();
      return { type: 'Point', coordinates: p };
    }
    case 2:
      return { type: 'LineString', coordinates: ring() };
    case 3:
      return { type: 'Polygon', coordinates: rings() };
    case 4:
      return {
        type: 'MultiPoint',
        coordinates: many<Point>().map((g) => g.coordinates),
      } as MultiPoint;
    case 5:
      return {
        type: 'MultiLineString',
        coordinates: many<LineString>().map((g) => g.coordinates),
      } as MultiLineString;
    case 6:
      return {
        type: 'MultiPolygon',
        coordinates: many<Polygon>().map((g) => g.coordinates),
      } as MultiPolygon;
    case 7:
      return { type: 'GeometryCollection', geometries: many<Geometry>() } as GeometryCollection;
    default:
      throw new Error(`unsupported WKB geometry type ${type}`);
  }
}

/** Parse PostGIS hex (E)WKB, as node-postgres returns geometry columns, into GeoJSON. */
export function parseEwkbHex(hex: string): Geometry {
  const r = new WkbReader(hexToBytes(hex));
  const g = readGeometry(r);
  if (!r.done) throw new Error('trailing bytes after WKB geometry');
  return g;
}
