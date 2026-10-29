import { PMTiles, type Source } from 'pmtiles';
import { describe, expect, test } from 'vitest';
import { lngLatToTile } from '../../src/ui/map/tile-math';
import { decodeMvt } from './mvt';
import { buildSyntheticBasemap, SYNTHETIC_MAX_ZOOM, syntheticFeatures } from './synthetic-basemap';

class BufferSource implements Source {
  constructor(private readonly buf: Buffer) {}
  getKey() {
    return 'memory';
  }
  async getBytes(offset: number, length: number) {
    const s = this.buf.subarray(offset, offset + length);
    return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.length) as ArrayBuffer };
  }
}

describe('synthetic basemap fixture', () => {
  const buf = buildSyntheticBasemap();
  const pm = new PMTiles(new BufferSource(buf));

  test('is a small, deterministic PMTiles v3 MVT archive over the AOI', async () => {
    expect(buf.length).toBeGreaterThan(10_000);
    expect(buf.length).toBeLessThan(5_000_000);
    expect(buildSyntheticBasemap().equals(buf)).toBe(true);
    const h = await pm.getHeader();
    expect(h.minZoom).toBe(0);
    expect(h.maxZoom).toBe(SYNTHETIC_MAX_ZOOM);
    expect(h.minLon).toBeCloseTo(-84.45, 5);
    expect(h.maxLon).toBeCloseTo(-83.1, 5);
    expect(await pm.getMetadata()).toMatchObject({
      attribution: expect.stringMatching(/Synthetic/),
    });
  });

  test('the Adrian tile carries the Protomaps v4 layers and a labelled locality', async () => {
    const t = lngLatToTile(-84.0372, 41.8975, 12);
    const r = await pm.getZxy(t.z, t.x, t.y);
    expect(r).toBeDefined();
    const layers = decodeMvt(new Uint8Array(r?.data ?? new ArrayBuffer(0)));
    const names = layers.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(['earth', 'roads', 'places']));
    const places = layers.find((l) => l.name === 'places');
    expect(places?.features.map((f) => f.properties.name)).toContain('Adrian');
    const adrian = places?.features.find((f) => f.properties.name === 'Adrian');
    expect(adrian?.properties).toMatchObject({ kind: 'locality', min_zoom: 7 });
    const roads = layers.find((l) => l.name === 'roads');
    const kinds = new Set(roads?.features.map((f) => f.properties.kind));
    expect(kinds.has('major_road')).toBe(true);
    expect(kinds.has('minor_road')).toBe(true);
    for (const l of layers) {
      for (const f of l.features) {
        for (const part of f.parts) {
          for (const [x, y] of part) {
            expect(x).toBeGreaterThanOrEqual(-64);
            expect(x).toBeLessThanOrEqual(4096 + 64);
            expect(y).toBeGreaterThanOrEqual(-64);
            expect(y).toBeLessThanOrEqual(4096 + 64);
          }
        }
      }
    }
  });

  test('minor roads only appear from z11; towns respect their min_zoom', async () => {
    const t9 = lngLatToTile(-84.0372, 41.8975, 9);
    const r = await pm.getZxy(t9.z, t9.x, t9.y);
    const layers = decodeMvt(new Uint8Array(r?.data ?? new ArrayBuffer(0)));
    const roads = layers.find((l) => l.name === 'roads');
    expect(roads?.features.some((f) => f.properties.kind === 'minor_road')).toBe(false);
    const names = layers.find((l) => l.name === 'places')?.features.map((f) => f.properties.name);
    expect(names).toContain('Adrian');
    expect(names).not.toContain('Riga');
  });

  test('features include the section grid, the lake and the state line', () => {
    const f = syntheticFeatures();
    expect(f.filter((x) => x.properties.kind === 'minor_road').length).toBeGreaterThan(80);
    expect(f.some((x) => x.properties.name === 'Lake Erie')).toBe(true);
    expect(f.some((x) => x.layer === 'boundaries')).toBe(true);
  });
});
