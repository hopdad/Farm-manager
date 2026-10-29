/**
 * A PMTiles v3 writer (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) for small
 * archives built in memory, e.g. the synthetic basemap fixture. Real basemaps come from
 * `pmtiles extract` (go-pmtiles in Docker); this exists so tests and CI can build an offline
 * archive without the network. Reading back is done with the `pmtiles` package.
 *
 * Layout: header (127 bytes) | root directory | JSON metadata | leaf directories | tile data.
 * Tile data is written in tile-id order (clustered); identical tiles are stored once and
 * consecutive identical tiles share one run-length entry.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

export const PMTILES_HEADER_BYTES = 127;
/** The header plus the root directory must fit in the first 16 KiB (spec). */
const ROOT_LIMIT = 16_384;

/** Matches the `pmtiles` package's Compression enum. */
export const PmCompression = { None: 1, Gzip: 2 } as const;
/** Matches the `pmtiles` package's TileType enum. */
export const PmTileType = { Mvt: 1, Png: 2 } as const;

export interface PmtilesInputTile {
  z: number;
  x: number;
  y: number;
  /** Tile bytes, already compressed with `tileCompression`. */
  data: Uint8Array;
}

export interface PmtilesWriteOptions {
  tileType: (typeof PmTileType)[keyof typeof PmTileType];
  tileCompression: (typeof PmCompression)[keyof typeof PmCompression];
  /** Directories and metadata (default gzip). */
  internalCompression?: (typeof PmCompression)[keyof typeof PmCompression];
  /** [minLon, minLat, maxLon, maxLat]. */
  bounds: readonly [number, number, number, number];
  /** [lon, lat, zoom]. */
  center: readonly [number, number, number];
  metadata: Record<string, unknown>;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function varints(values: Iterable<number>, out: number[]): void {
  for (const value of values) {
    let n = value;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`varint out of range: ${n}`);
    while (n >= 0x80) {
      out.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    out.push(n);
  }
}

/** Directory serialization (spec §4): count, tile-id deltas, run lengths, lengths, offsets. */
export function serializeDirectory(entries: readonly Entry[]): Uint8Array {
  const out: number[] = [];
  varints([entries.length], out);
  let last = 0;
  varints(
    entries.map((e) => {
      const d = e.tileId - last;
      last = e.tileId;
      return d;
    }),
    out,
  );
  varints(
    entries.map((e) => e.runLength),
    out,
  );
  varints(
    entries.map((e) => e.length),
    out,
  );
  varints(
    entries.map((e, i) => {
      const prev = entries[i - 1];
      return i > 0 && prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1;
    }),
    out,
  );
  return Uint8Array.from(out);
}

function compress(data: Uint8Array, c: number): Uint8Array {
  return c === PmCompression.Gzip ? gzipSync(data, { level: 9 }) : data;
}

/** Split entries into leaves until the root directory fits next to the header. */
function buildDirectories(
  entries: Entry[],
  internal: number,
): { root: Uint8Array; leaves: Uint8Array } {
  const root = compress(serializeDirectory(entries), internal);
  if (PMTILES_HEADER_BYTES + root.length <= ROOT_LIMIT) return { root, leaves: new Uint8Array() };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries: Entry[] = [];
    const leafChunks: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const slice = entries.slice(i, i + leafSize);
      const leaf = compress(serializeDirectory(slice), internal);
      rootEntries.push({
        tileId: (slice[0] as Entry).tileId,
        offset,
        length: leaf.length,
        runLength: 0,
      });
      leafChunks.push(leaf);
      offset += leaf.length;
    }
    const r = compress(serializeDirectory(rootEntries), internal);
    if (PMTILES_HEADER_BYTES + r.length <= ROOT_LIMIT) {
      return { root: r, leaves: Buffer.concat(leafChunks) };
    }
  }
}

/** Build a complete PMTiles v3 archive. */
export function writePmtiles(
  tiles: readonly PmtilesInputTile[],
  opts: PmtilesWriteOptions,
): Buffer {
  if (tiles.length === 0) throw new Error('writePmtiles: no tiles');
  const internal = opts.internalCompression ?? PmCompression.Gzip;
  const sorted = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), t }))
    .sort((a, b) => a.id - b.id);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.id === sorted[i - 1]?.id) throw new Error('writePmtiles: duplicate tile');
  }

  const entries: Entry[] = [];
  const chunks: Uint8Array[] = [];
  const byHash = new Map<string, { offset: number; length: number }>();
  let dataLength = 0;
  for (const { id, t } of sorted) {
    const hash = createHash('sha256').update(t.data).digest('hex');
    let loc = byHash.get(hash);
    if (!loc) {
      loc = { offset: dataLength, length: t.data.length };
      byHash.set(hash, loc);
      chunks.push(t.data);
      dataLength += t.data.length;
    }
    const prev = entries[entries.length - 1];
    if (
      prev &&
      prev.tileId + prev.runLength === id &&
      prev.offset === loc.offset &&
      prev.length === loc.length
    ) {
      prev.runLength += 1;
    } else {
      entries.push({ tileId: id, offset: loc.offset, length: loc.length, runLength: 1 });
    }
  }

  const { root, leaves } = buildDirectories(entries, internal);
  const metadata = compress(new TextEncoder().encode(JSON.stringify(opts.metadata)), internal);
  const zooms = tiles.map((t) => t.z);

  const rootOffset = PMTILES_HEADER_BYTES;
  const metadataOffset = rootOffset + root.length;
  const leavesOffset = metadataOffset + metadata.length;
  const dataOffset = leavesOffset + leaves.length;

  const header = Buffer.alloc(PMTILES_HEADER_BYTES);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  const u64 = (pos: number, v: number) => header.writeBigUInt64LE(BigInt(v), pos);
  u64(8, rootOffset);
  u64(16, root.length);
  u64(24, metadataOffset);
  u64(32, metadata.length);
  u64(40, leavesOffset);
  u64(48, leaves.length);
  u64(56, dataOffset);
  u64(64, dataLength);
  u64(72, tiles.length);
  u64(80, entries.length);
  u64(88, byHash.size);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(internal, 97);
  header.writeUInt8(opts.tileCompression, 98);
  header.writeUInt8(opts.tileType, 99);
  header.writeUInt8(Math.min(...zooms), 100);
  header.writeUInt8(Math.max(...zooms), 101);
  const e7 = (deg: number) => Math.round(deg * 1e7);
  header.writeInt32LE(e7(opts.bounds[0]), 102);
  header.writeInt32LE(e7(opts.bounds[1]), 106);
  header.writeInt32LE(e7(opts.bounds[2]), 110);
  header.writeInt32LE(e7(opts.bounds[3]), 114);
  header.writeUInt8(Math.round(opts.center[2]), 118);
  header.writeInt32LE(e7(opts.center[0]), 119);
  header.writeInt32LE(e7(opts.center[1]), 123);

  return Buffer.concat([header, root, metadata, leaves, ...chunks]);
}
