/** NAIP request math, the fixture transport and the gis:naip arguments (pure). */
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { tileToBBox } from '../../src/ui/map/tile-math';
import { parseNaipArgs } from './naip';
import { NAIP_FIXTURE_JPEG, naipFixtureFetch } from './naip-fixture';
import {
  isJpeg,
  NAIP_IMAGE_SERVER,
  naipExportUrl,
  naipOnlineTemplate,
  tileBounds3857,
  tileCountUpperBound,
  tilePath,
  tilesForArea,
} from './naip-tiles';

const square = (w: number, s: number, e: number, n: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

describe('tile bounds and requests', () => {
  test('EPSG:3857 bounds of known tiles', () => {
    expect(tileBounds3857({ z: 0, x: 0, y: 0 })).toEqual([
      -20037508.342789244, -20037508.342789244, 20037508.342789244, 20037508.342789244,
    ]);
    const [minx, miny, maxx, maxy] = tileBounds3857({ z: 1, x: 1, y: 0 });
    expect([minx, miny]).toEqual([0, 0]);
    expect(maxx).toBeCloseTo(20037508.342789244, 6);
    expect(maxy).toBeCloseTo(20037508.342789244, 6);
  });

  test('one exportImage per tile: 256 px, Web Mercator in and out, JPEG bytes back', () => {
    const u = new URL(naipExportUrl({ z: 15, x: 8516, y: 12058 }));
    expect(`${u.origin}${u.pathname}`).toBe(`${NAIP_IMAGE_SERVER}/exportImage`);
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      bboxSR: '3857',
      imageSR: '3857',
      size: '256,256',
      format: 'jpg',
      f: 'image',
    });
    const bbox = (q.bbox ?? '').split(',').map(Number);
    expect(bbox).toHaveLength(4);
    expect((bbox[2] as number) - (bbox[0] as number)).toBeCloseTo(1222.99, 1); // z15 tile width in m
  });

  test('the online template lets MapLibre fill the bbox', () => {
    expect(naipOnlineTemplate()).toContain('bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857');
    expect(naipOnlineTemplate('https://x.example/ImageServer')).toMatch(
      /^https:\/\/x\.example\/ImageServer\/exportImage\?/,
    );
  });
});

describe('tilesForArea', () => {
  test('only tiles touching the area, at every zoom asked for', () => {
    // Two small blobs far apart: their bbox spans many tiles the area doesn't touch.
    const area = {
      type: 'MultiPolygon' as const,
      coordinates: [
        square(-84.05, 41.9, -84.04, 41.91).coordinates,
        square(-83.7, 41.95, -83.69, 41.96).coordinates,
      ],
    };
    const tiles = tilesForArea(area, 13, 14);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([13, 14]));
    expect(tiles.length).toBeLessThan(tileCountUpperBound(area, 13, 14) / 4);
    for (const t of tiles) {
      const [w, s, e, n] = tileToBBox(t);
      const inA = w <= -84.04 && e >= -84.05 && s <= 41.91 && n >= 41.9;
      const inB = w <= -83.69 && e >= -83.7 && s <= 41.96 && n >= 41.95;
      expect(inA || inB).toBe(true);
    }
    expect(() => tilesForArea(area, 15, 14)).toThrow(/zoom/);
  });

  test('tile paths are z/x/y.jpg', () => {
    expect(tilePath({ z: 12, x: 1, y: 2 })).toBe('12/1/2.jpg');
  });
});

describe('fixture transport', () => {
  test('answers exportImage with a JPEG and anything else with an ArcGIS-style 404', async () => {
    expect(isJpeg(NAIP_FIXTURE_JPEG)).toBe(true);
    expect(isJpeg(new TextEncoder().encode('{"error":{}}'))).toBe(false);
    const f = naipFixtureFetch();
    const ok = await f(naipExportUrl({ z: 14, x: 4258, y: 6029 }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(isJpeg(new Uint8Array(await ok.arrayBuffer()))).toBe(true);
    const bad = await f(`${NAIP_IMAGE_SERVER}?f=json`);
    expect(bad.status).toBe(404);
    expect(f.requests).toHaveLength(2);
  });
});

describe('gis:naip arguments', () => {
  test('defaults and modes', () => {
    expect(parseNaipArgs([])).toMatchObject({
      mode: 'full',
      minzoom: 12,
      maxzoom: 17,
      concurrency: 4,
    });
    expect(parseNaipArgs(['--online-only']).mode).toBe('online-only');
    expect(parseNaipArgs(['--offline']).mode).toBe('offline');
    expect(parseNaipArgs(['--fixture', '--maxzoom', '14', '--vintage', 'NAIP 2024'])).toMatchObject(
      {
        mode: 'fixture',
        maxzoom: 14,
        vintage: 'NAIP 2024',
      },
    );
  });

  test('refuses conflicting or bad options', () => {
    expect(() => parseNaipArgs(['--offline', '--fixture'])).toThrow(/pick one/);
    expect(() => parseNaipArgs(['--minzoom', '16', '--maxzoom', '14'])).toThrow(/minzoom/);
    expect(() => parseNaipArgs(['--maxzoom', '25'])).toThrow(/maxzoom/);
    expect(() => parseNaipArgs(['--concurrency', '0'])).toThrow(/concurrency/);
  });
});
