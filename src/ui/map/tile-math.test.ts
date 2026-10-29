import { describe, expect, test } from 'vitest';
import { tileFor } from '../../test/fixtures';
import {
  bboxCenter,
  bboxesIntersect,
  isValidTile,
  lngLatToTile,
  lngLatToTilePixel,
  lngLatToWorld,
  MAX_MERCATOR_LAT,
  padBBox,
  tilesCoveringBBox,
  tileToBBox,
  worldToLngLat,
} from './tile-math';

describe('tile math', () => {
  test('world coordinates round-trip', () => {
    for (const [lng, lat] of [
      [-84.06, 41.89],
      [0, 0],
      [179.9, -60],
      [-179.9, 80],
    ] as const) {
      const [x, y] = lngLatToWorld(lng, lat);
      const [lng2, lat2] = worldToLngLat(x, y);
      expect(lng2).toBeCloseTo(lng, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
    expect(lngLatToWorld(0, 0)).toEqual([0.5, 0.5]);
  });

  test('lngLatToTile agrees with the test fixture and known tiles', () => {
    for (const z of [0, 5, 10, 14, 18]) {
      expect(lngLatToTile(-84.06, 41.89, z)).toEqual(tileFor(-84.06, 41.89, z));
    }
    // Adrian, MI at z10 (checked against the slippy-map formula by hand).
    expect(lngLatToTile(-84.037, 41.897, 10)).toEqual({ z: 10, x: 272, y: 380 });
    // Poles and the antimeridian clamp into range.
    expect(lngLatToTile(180, 90, 3)).toEqual({ z: 3, x: 7, y: 0 });
    expect(lngLatToTile(-180, -90, 3)).toEqual({ z: 3, x: 0, y: 7 });
  });

  test('tileToBBox contains the point the tile was computed from', () => {
    const t = lngLatToTile(-83.86, 41.83, 13);
    const [w, s, e, n] = tileToBBox(t);
    expect(w).toBeLessThanOrEqual(-83.86);
    expect(e).toBeGreaterThan(-83.86);
    expect(s).toBeLessThanOrEqual(41.83);
    expect(n).toBeGreaterThan(41.83);
    expect(tileToBBox({ z: 0, x: 0, y: 0 })[3]).toBeCloseTo(MAX_MERCATOR_LAT, 6);
  });

  test('isValidTile', () => {
    expect(isValidTile(0, 0, 0)).toBe(true);
    expect(isValidTile(14, 16383, 16383)).toBe(true);
    expect(isValidTile(14, 16384, 0)).toBe(false);
    expect(isValidTile(-1, 0, 0)).toBe(false);
    expect(isValidTile(23, 0, 0)).toBe(false);
    expect(isValidTile(1.5, 0, 0)).toBe(false);
    expect(isValidTile(10, 0, 0, 8)).toBe(false);
  });

  test('tilesCoveringBBox covers the SE Michigan extract area', () => {
    const bbox = [-84.45, 41.65, -83.1, 42.15] as const;
    expect(tilesCoveringBBox(bbox, 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
    const z10 = tilesCoveringBBox(bbox, 10);
    const xs = new Set(z10.map((t) => t.x));
    const ys = new Set(z10.map((t) => t.y));
    expect(z10.length).toBe(xs.size * ys.size);
    expect(z10).toContainEqual(lngLatToTile(-84.037, 41.897, 10));
    for (const t of z10) expect(bboxesIntersect(tileToBBox(t), bbox)).toBe(true);
  });

  test('lngLatToTilePixel maps tile corners to 0 and extent', () => {
    const t = { z: 12, x: 1090, y: 1515 };
    const [w, s, e, n] = tileToBBox(t);
    expect(lngLatToTilePixel(w, n, t)).toEqual([0, 0]);
    expect(lngLatToTilePixel(e, s, t)).toEqual([4096, 4096]);
  });

  test('bbox helpers', () => {
    expect(bboxesIntersect([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(bboxesIntersect([0, 0, 1, 1], [1.1, 0, 2, 1])).toBe(false);
    expect(padBBox([0, 0, 10, 20], 0.1)).toEqual([-1, -2, 11, 22]);
    expect(bboxCenter([-2, -1, 2, 3])).toEqual([0, 1]);
  });
});
