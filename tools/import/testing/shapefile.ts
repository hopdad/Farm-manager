/**
 * TEST FIXTURES ONLY: a minimal ESRI shapefile writer (polygons, character attributes) and a
 * zip writer, so tests (and the e2e upload) build Operations-Center-style exports at test time
 * instead of committing binary files. Follows the ESRI Shapefile Technical Description (1998):
 * 100-byte header (file code 9994 and length big-endian, version 1000 and shape type
 * little-endian), records with a big-endian header, shape type 5 = Polygon with outer rings
 * clockwise and holes counter-clockwise; dBASE III .dbf with 'C' fields. The zip uses deflate
 * (method 8), like the real exports, with node:zlib.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import type { MultiPolygon, Polygon, Position } from 'geojson';

export interface ShpFeature {
  geometry: Polygon | MultiPolygon;
  attributes: Record<string, string>;
}

/** WGS84 geographic, as ArcGIS writes it. */
export const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** NAD83 / UTM zone 17N (metres): eastern Lenawee and Monroe counties. */
export const UTM17N_PRJ =
  'PROJCS["NAD_1983_UTM_Zone_17N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-81.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

/** Signed area (shoelace); negative = clockwise in x/y. */
function signedArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i] as [number, number];
    const [x2, y2] = ring[i + 1] as [number, number];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Shapefile ring order: outer rings clockwise, holes counter-clockwise. */
function orient(ring: Position[], clockwise: boolean): Position[] {
  const cw = signedArea(ring) < 0;
  return cw === clockwise ? ring : [...ring].reverse();
}

function partsOf(g: Polygon | MultiPolygon): Position[][] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out: Position[][] = [];
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      out.push(orient(ring, i === 0));
    });
  }
  return out;
}

function bboxOf(points: Position[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points as [number, number][]) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  return [w, s, e, n];
}

/** .shp and .shx for polygon features. */
export function writeShp(geoms: (Polygon | MultiPolygon)[]): { shp: Uint8Array; shx: Uint8Array } {
  const records = geoms.map((g) => {
    const parts = partsOf(g);
    const points = parts.flat();
    const len = 4 + 32 + 4 + 4 + 4 * parts.length + 16 * points.length;
    const buf = new DataView(new ArrayBuffer(len));
    buf.setInt32(0, 5, true);
    const bb = bboxOf(points);
    for (const [i, v] of bb.entries()) buf.setFloat64(4 + i * 8, v, true);
    buf.setInt32(36, parts.length, true);
    buf.setInt32(40, points.length, true);
    let off = 44;
    let start = 0;
    for (const p of parts) {
      buf.setInt32(off, start, true);
      off += 4;
      start += p.length;
    }
    for (const [x, y] of points as [number, number][]) {
      buf.setFloat64(off, x, true);
      buf.setFloat64(off + 8, y, true);
      off += 16;
    }
    return { content: new Uint8Array(buf.buffer), bbox: bb };
  });
  const all = records.length
    ? bboxOf(
        records.flatMap((r) => [
          [r.bbox[0], r.bbox[1]],
          [r.bbox[2], r.bbox[3]],
        ]),
      )
    : [0, 0, 0, 0];
  const header = (fileBytes: number) => {
    const h = new DataView(new ArrayBuffer(100));
    h.setInt32(0, 9994);
    h.setInt32(24, fileBytes / 2);
    h.setInt32(28, 1000, true);
    h.setInt32(32, 5, true);
    for (const [i, v] of all.entries()) h.setFloat64(36 + i * 8, v, true);
    return new Uint8Array(h.buffer);
  };
  const shpLen = 100 + records.reduce((n, r) => n + 8 + r.content.length, 0);
  const shp = new Uint8Array(shpLen);
  shp.set(header(shpLen), 0);
  const shxLen = 100 + 8 * records.length;
  const shx = new Uint8Array(shxLen);
  shx.set(header(shxLen), 0);
  const shpView = new DataView(shp.buffer);
  const shxView = new DataView(shx.buffer);
  let off = 100;
  records.forEach((r, i) => {
    shpView.setInt32(off, i + 1);
    shpView.setInt32(off + 4, r.content.length / 2);
    shp.set(r.content, off + 8);
    shxView.setInt32(100 + i * 8, off / 2);
    shxView.setInt32(100 + i * 8 + 4, r.content.length / 2);
    off += 8 + r.content.length;
  });
  return { shp, shx };
}

/** dBASE III table of character fields (names cut to 10 characters, as real exports do). */
export function writeDbf(
  rows: Record<string, string>[],
  keys: string[] = [...new Set(rows.flatMap((r) => Object.keys(r)))],
): Uint8Array {
  const enc = new TextEncoder();
  const names = keys.map((k) => k.slice(0, 10));
  const widths = keys.map((k) => Math.max(1, ...rows.map((r) => enc.encode(r[k] ?? '').length)));
  const headerLen = 32 + 32 * names.length + 1;
  const recordLen = 1 + widths.reduce((a, b) => a + b, 0);
  const buf = new Uint8Array(headerLen + recordLen * rows.length + 1);
  const view = new DataView(buf.buffer);
  buf[0] = 0x03;
  buf[1] = 126;
  buf[2] = 10;
  buf[3] = 29;
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLen, true);
  view.setUint16(10, recordLen, true);
  names.forEach((n, i) => {
    const at = 32 + i * 32;
    buf.set(enc.encode(n), at);
    buf[at + 11] = 'C'.charCodeAt(0);
    buf[at + 16] = widths[i] as number;
  });
  buf[32 + 32 * names.length] = 0x0d;
  rows.forEach((r, ri) => {
    let at = headerLen + ri * recordLen;
    buf[at++] = 0x20;
    keys.forEach((k, i) => {
      const w = widths[i] as number;
      const cell = new Uint8Array(w).fill(0x20);
      cell.set(enc.encode(r[k] ?? '').slice(0, w));
      buf.set(cell, at);
      at += w;
    });
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}

/** The files of one shapefile named `base` (paths allowed: 'Client/Farm/Boundary'). */
export function shapefileFiles(
  base: string,
  features: ShpFeature[],
  opts: { prj?: string | null; fields?: string[] } = {},
): Record<string, Uint8Array> {
  const { shp, shx } = writeShp(features.map((f) => f.geometry));
  const out: Record<string, Uint8Array> = {
    [`${base}.shp`]: shp,
    [`${base}.shx`]: shx,
    [`${base}.dbf`]: writeDbf(
      features.map((f) => f.attributes),
      opts.fields,
    ),
  };
  const prj = opts.prj === undefined ? WGS84_PRJ : opts.prj;
  if (prj) out[`${base}.prj`] = new TextEncoder().encode(prj);
  return out;
}

/** A zip of the given files (deflate), as `Uint8Array`. */
export function zip(files: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const deflated = new Uint8Array(deflateRawSync(data));
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, deflated.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 8, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, deflated.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, deflated);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Metres -> degrees near `lat` (enough for fixtures). */
export function rectangle(lng: number, lat: number, widthM: number, heightM: number): Polygon {
  const dLat = heightM / 111_132;
  const dLng = widthM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + dLng, lat],
        [lng + dLng, lat + dLat],
        [lng, lat + dLat],
        [lng, lat],
      ],
    ],
  };
}
