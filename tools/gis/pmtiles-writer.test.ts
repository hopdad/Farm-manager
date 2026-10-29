/**
 * writePmtiles, read back with the `pmtiles` package (the reader MapLibre's protocol uses; its
 * getZxy returns tiles already decompressed).
 */
import { gzipSync } from 'node:zlib';
import { PMTiles, type Source, TileType } from 'pmtiles';
import { describe, expect, test } from 'vitest';
import { PMTILES_HEADER_BYTES, PmCompression, PmTileType, writePmtiles } from './pmtiles-writer';

class BufferSource implements Source {
  constructor(private readonly buf: Buffer) {}
  getKey() {
    return 'memory';
  }
  async getBytes(offset: number, length: number) {
    const slice = this.buf.subarray(offset, offset + length);
    return {
      data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) as ArrayBuffer,
    };
  }
}

const tile = (z: number, x: number, y: number, text: string) => ({
  z,
  x,
  y,
  data: gzipSync(Buffer.from(text)),
});

describe('writePmtiles', () => {
  test('header, metadata and tiles read back with the pmtiles reader', async () => {
    const same = gzipSync(Buffer.from('same'));
    const buf = writePmtiles(
      [
        tile(0, 0, 0, 'z0'),
        tile(1, 1, 0, 'z1-b'),
        tile(1, 0, 0, 'z1-a'),
        { z: 2, x: 0, y: 0, data: same },
        { z: 2, x: 1, y: 0, data: same },
      ],
      {
        tileType: PmTileType.Mvt,
        tileCompression: PmCompression.Gzip,
        bounds: [-84.45, 41.65, -83.1, 42.15],
        center: [-83.775, 41.9, 10],
        metadata: { name: 'test', vector_layers: [] },
      },
    );
    expect(buf.subarray(0, 7).toString('latin1')).toBe('PMTiles');
    expect(buf[7]).toBe(3);

    const pm = new PMTiles(new BufferSource(buf));
    const h = await pm.getHeader();
    expect(h).toMatchObject({
      specVersion: 3,
      rootDirectoryOffset: PMTILES_HEADER_BYTES,
      minZoom: 0,
      maxZoom: 2,
      numAddressedTiles: 5,
      numTileContents: 4,
      clustered: true,
      tileType: PmTileType.Mvt,
      tileCompression: PmCompression.Gzip,
      internalCompression: PmCompression.Gzip,
    });
    expect(h.minLon).toBeCloseTo(-84.45, 6);
    expect(h.maxLat).toBeCloseTo(42.15, 6);
    expect(h.centerZoom).toBe(10);
    // z2 tiles 0/0 and 1/0 are consecutive Hilbert ids with the same bytes: one run-length entry.
    expect(h.numTileEntries).toBe(4);
    expect(await pm.getMetadata()).toEqual({ name: 'test', vector_layers: [] });

    const read = async (z: number, x: number, y: number) => {
      const r = await pm.getZxy(z, x, y);
      return r ? Buffer.from(r.data).toString() : null;
    };
    expect(await read(0, 0, 0)).toBe('z0');
    expect(await read(1, 0, 0)).toBe('z1-a');
    expect(await read(1, 1, 0)).toBe('z1-b');
    expect(await read(2, 0, 0)).toBe('same');
    expect(await read(2, 1, 0)).toBe('same');
    expect(await read(2, 3, 3)).toBeNull();
  });

  test('many tiles spill into leaf directories and still resolve', async () => {
    const tiles = [];
    for (let x = 0; x < 128; x++) {
      for (let y = 0; y < 128; y++) tiles.push(tile(7, x, y, `${x}/${y}`));
    }
    const buf = writePmtiles(tiles, {
      tileType: PmTileType.Mvt,
      tileCompression: PmCompression.Gzip,
      internalCompression: PmCompression.None,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 7],
      metadata: {},
    });
    const pm = new PMTiles(new BufferSource(buf));
    const h = await pm.getHeader();
    expect(h.leafDirectoryLength).toBeGreaterThan(0);
    expect(h.rootDirectoryOffset + h.rootDirectoryLength).toBeLessThanOrEqual(16_384);
    for (const [x, y] of [
      [0, 0],
      [127, 127],
      [64, 3],
    ] as const) {
      const r = await pm.getZxy(7, x, y);
      expect(r && Buffer.from(r.data).toString()).toBe(`${x}/${y}`);
    }
  });

  test('rejects empty input and duplicate tiles', () => {
    const opts = {
      tileType: PmTileType.Mvt,
      tileCompression: PmCompression.Gzip,
      bounds: [0, 0, 1, 1],
      center: [0, 0, 0],
      metadata: {},
    } as const;
    expect(() => writePmtiles([], opts)).toThrow('no tiles');
    expect(() => writePmtiles([tile(0, 0, 0, 'a'), tile(0, 0, 0, 'b')], opts)).toThrow('duplicate');
  });
});

test('PmTileType matches the pmtiles package (raster archives for NAIP close-ups, 1d)', () => {
  expect(PmTileType).toEqual({
    Mvt: TileType.Mvt,
    Png: TileType.Png,
    Jpeg: TileType.Jpeg,
    Webp: TileType.Webp,
    Avif: TileType.Avif,
  });
});
