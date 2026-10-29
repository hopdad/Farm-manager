/**
 * A small Mapbox Vector Tile 2.1 encoder and decoder (https://github.com/mapbox/vector-tile-spec).
 * Used to build the synthetic basemap fixture (./synthetic-basemap.ts) and, in tests, to read
 * tiles back (including PostGIS's ST_AsMVT output). No dependencies.
 *
 * Geometry is in tile-local integer coordinates (0..extent, y down). Polygon rings are oriented
 * by the encoder: exterior rings get positive area (clockwise on screen), holes negative.
 */

export type MvtValue = string | number | boolean;
export type MvtPoint = readonly [number, number];

export type MvtGeometry =
  | { type: 'Point'; points: MvtPoint[] }
  | { type: 'LineString'; lines: MvtPoint[][] }
  /** Each polygon is [exterior, ...holes]. */
  | { type: 'Polygon'; polygons: MvtPoint[][][] };

export interface MvtFeature {
  id?: number;
  geometry: MvtGeometry;
  properties: Record<string, MvtValue>;
}

export interface MvtLayer {
  name: string;
  extent?: number;
  features: MvtFeature[];
}

const GEOM_TYPE = { Point: 1, LineString: 2, Polygon: 3 } as const;
const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

// ---------------------------------------------------------------------------------------------
// Protobuf writer
// ---------------------------------------------------------------------------------------------

class Writer {
  private chunks: number[] = [];

  varint(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`varint out of range: ${v}`);
    let n = v;
    while (n >= 0x80) {
      this.chunks.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.chunks.push(n);
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    for (const b of data) this.chunks.push(b);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }

  packed(field: number, values: number[]): this {
    const w = new Writer();
    for (const v of values) w.varint(v);
    return this.bytes(field, w.finish());
  }

  double(field: number, v: number): this {
    this.tag(field, 1);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    for (const x of b) this.chunks.push(x);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
const command = (id: number, count: number) => (count << 3) | (id & 0x7);

/** Signed area by the surveyor's formula, in tile coordinates (y down). */
export function ringArea(ring: readonly MvtPoint[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as MvtPoint;
    const [xj, yj] = ring[j] as MvtPoint;
    sum += xj * yi - xi * yj;
  }
  return sum / 2;
}

function dedupe(points: readonly MvtPoint[]): MvtPoint[] {
  const out: MvtPoint[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push([Math.round(p[0]), Math.round(p[1])]);
  }
  return out;
}

function encodeGeometry(g: MvtGeometry): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const move = (p: MvtPoint) => {
    out.push(zigzag(p[0] - cx), zigzag(p[1] - cy));
    cx = p[0];
    cy = p[1];
  };
  if (g.type === 'Point') {
    const pts = g.points.map((p) => [Math.round(p[0]), Math.round(p[1])] as const);
    if (pts.length === 0) return out;
    out.push(command(MOVE_TO, pts.length));
    for (const p of pts) move(p);
    return out;
  }
  if (g.type === 'LineString') {
    for (const line of g.lines) {
      const pts = dedupe(line);
      if (pts.length < 2) continue;
      out.push(command(MOVE_TO, 1));
      move(pts[0] as MvtPoint);
      out.push(command(LINE_TO, pts.length - 1));
      for (const p of pts.slice(1)) move(p);
    }
    return out;
  }
  for (const polygon of g.polygons) {
    polygon.forEach((rawRing, i) => {
      let ring = dedupe(rawRing);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1]) {
        ring = ring.slice(0, -1);
      }
      if (ring.length < 3) return;
      const area = ringArea(ring);
      if (area === 0) return;
      // Exterior positive, holes negative (spec 4.3.4.4).
      if ((i === 0 && area < 0) || (i > 0 && area > 0)) ring = ring.reverse();
      out.push(command(MOVE_TO, 1));
      move(ring[0] as MvtPoint);
      out.push(command(LINE_TO, ring.length - 1));
      for (const p of ring.slice(1)) move(p);
      out.push(command(CLOSE_PATH, 1));
    });
  }
  return out;
}

function encodeValue(v: MvtValue): Uint8Array {
  const w = new Writer();
  if (typeof v === 'string') w.string(1, v);
  else if (typeof v === 'boolean') w.tag(7, 0).varint(v ? 1 : 0);
  else if (Number.isSafeInteger(v)) {
    if (v >= 0) w.tag(5, 0).varint(v);
    else w.tag(6, 0).varint(zigzag(v));
  } else w.double(3, v);
  return w.finish();
}

/** Encode layers into one MVT. Features with empty geometry are dropped. */
export function encodeMvt(layers: readonly MvtLayer[]): Uint8Array {
  const tile = new Writer();
  for (const layer of layers) {
    const keys: string[] = [];
    const keyIndex = new Map<string, number>();
    const values: MvtValue[] = [];
    const valueIndex = new Map<string, number>();
    const lw = new Writer();
    lw.tag(15, 0).varint(2);
    lw.string(1, layer.name);
    for (const f of layer.features) {
      const geometry = encodeGeometry(f.geometry);
      if (geometry.length === 0) continue;
      const tags: number[] = [];
      for (const [k, v] of Object.entries(f.properties)) {
        let ki = keyIndex.get(k);
        if (ki === undefined) {
          ki = keys.push(k) - 1;
          keyIndex.set(k, ki);
        }
        const vk = `${typeof v}:${String(v)}`;
        let vi = valueIndex.get(vk);
        if (vi === undefined) {
          vi = values.push(v) - 1;
          valueIndex.set(vk, vi);
        }
        tags.push(ki, vi);
      }
      const fw = new Writer();
      if (f.id !== undefined) fw.tag(1, 0).varint(f.id);
      if (tags.length) fw.packed(2, tags);
      fw.tag(3, 0).varint(GEOM_TYPE[f.geometry.type]);
      fw.packed(4, geometry);
      lw.bytes(2, fw.finish());
    }
    for (const k of keys) lw.string(3, k);
    for (const v of values) lw.bytes(4, encodeValue(v));
    lw.tag(5, 0).varint(layer.extent ?? 4096);
    tile.bytes(3, lw.finish());
  }
  return tile.finish();
}

// ---------------------------------------------------------------------------------------------
// Decoder (tests and tooling)
// ---------------------------------------------------------------------------------------------

export interface DecodedFeature {
  id?: number;
  type: 'Unknown' | 'Point' | 'LineString' | 'Polygon';
  properties: Record<string, MvtValue>;
  /** Decoded parts (points / lines / rings) in tile coordinates. */
  parts: [number, number][][];
}

export interface DecodedLayer {
  version: number;
  name: string;
  extent: number;
  features: DecodedFeature[];
}

class Reader {
  pos = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly end = buf.length,
  ) {}
  more(): boolean {
    return this.pos < this.end;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('truncated varint');
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
    }
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  fixed(n: 4 | 8): DataView {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, n);
    this.pos += n;
    return view;
  }
}

function packed(data: Uint8Array): number[] {
  const r = new Reader(data);
  const out: number[] = [];
  while (r.more()) out.push(r.varint());
  return out;
}

function decodeValue(data: Uint8Array): MvtValue {
  const r = new Reader(data);
  let v: MvtValue = '';
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) v = new TextDecoder().decode(r.bytes());
    else if (field === 2) v = r.fixed(4).getFloat32(0, true);
    else if (field === 3) v = r.fixed(8).getFloat64(0, true);
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = unzigzag(r.varint());
    else if (field === 7) v = r.varint() !== 0;
    else r.skip(wire);
  }
  return v;
}

function decodeGeometry(cmds: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let x = 0;
  let y = 0;
  let current: [number, number][] | null = null;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++] as number;
    const id = c & 7;
    const count = c >> 3;
    if (id === CLOSE_PATH) {
      if (current?.[0]) current.push([current[0][0], current[0][1]]);
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += unzigzag(cmds[i++] as number);
      y += unzigzag(cmds[i++] as number);
      if (id === MOVE_TO) {
        current = [];
        parts.push(current);
      }
      current?.push([x, y]);
    }
  }
  return parts;
}

const TYPES = ['Unknown', 'Point', 'LineString', 'Polygon'] as const;

export function decodeMvt(buf: Uint8Array): DecodedLayer[] {
  const r = new Reader(buf);
  const layers: DecodedLayer[] = [];
  while (r.more()) {
    const tag = r.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      r.skip(tag & 7);
      continue;
    }
    const lr = new Reader(r.bytes());
    const layer: DecodedLayer = { version: 1, name: '', extent: 4096, features: [] };
    const keys: string[] = [];
    const values: MvtValue[] = [];
    const raw: { id?: number; type: number; tags: number[]; geometry: number[] }[] = [];
    while (lr.more()) {
      const t = lr.varint();
      const field = t >> 3;
      if (field === 15) layer.version = lr.varint();
      else if (field === 1) layer.name = new TextDecoder().decode(lr.bytes());
      else if (field === 5) layer.extent = lr.varint();
      else if (field === 3) keys.push(new TextDecoder().decode(lr.bytes()));
      else if (field === 4) values.push(decodeValue(lr.bytes()));
      else if (field === 2) {
        const fr = new Reader(lr.bytes());
        const f: { id?: number; type: number; tags: number[]; geometry: number[] } = {
          type: 0,
          tags: [],
          geometry: [],
        };
        while (fr.more()) {
          const ft = fr.varint();
          const ff = ft >> 3;
          if (ff === 1) f.id = fr.varint();
          else if (ff === 2) f.tags = packed(fr.bytes());
          else if (ff === 3) f.type = fr.varint();
          else if (ff === 4) f.geometry = packed(fr.bytes());
          else fr.skip(ft & 7);
        }
        raw.push(f);
      } else lr.skip(t & 7);
    }
    for (const f of raw) {
      const properties: Record<string, MvtValue> = {};
      for (let i = 0; i + 1 < f.tags.length; i += 2) {
        const k = keys[f.tags[i] as number];
        const v = values[f.tags[i + 1] as number];
        if (k !== undefined && v !== undefined) properties[k] = v;
      }
      layer.features.push({
        ...(f.id !== undefined ? { id: f.id } : {}),
        type: TYPES[f.type] ?? 'Unknown',
        properties,
        parts: decodeGeometry(f.geometry),
      });
    }
    layers.push(layer);
  }
  return layers;
}
