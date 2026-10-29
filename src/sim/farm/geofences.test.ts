import { describe, expect, test } from 'vitest';
import { demoId } from '../../domain/ids';
import { localDistance } from '../geo/lnglat';
import type { LngLat } from '../types';
import { buildDemoFarm } from './build';
import {
  ENTRANCE_ALONG_M,
  ENTRANCE_FIELD_SIDE_M,
  ENTRANCE_ROAD_SIDE_M,
  fieldEntranceGeofences,
  fieldEntranceKey,
} from './geofences';

const farm = buildDemoFarm();
const fences = fieldEntranceGeofences(farm);

function bbox(ring: readonly number[][]) {
  const xs = ring.map((p) => p[0] as number);
  const ys = ring.map((p) => p[1] as number);
  return { w: Math.min(...xs), e: Math.max(...xs), s: Math.min(...ys), n: Math.max(...ys) };
}

describe('field entrance geofences', () => {
  test('one per field, deterministic ids and keys, named after the field', () => {
    expect(fences).toHaveLength(farm.fields.length);
    expect(new Set(fences.map((g) => g.id)).size).toBe(fences.length);
    for (const [i, g] of fences.entries()) {
      const f = farm.fields[i];
      expect(g.fieldId).toBe(f?.id);
      expect(g.key).toBe(fieldEntranceKey(f?.key as string));
      expect(g.id).toBe(demoId(g.key));
      expect(g.kind).toBe('field_entrance');
      expect(g.name).toBe(`${f?.name} entrance`);
    }
    expect(fieldEntranceGeofences(buildDemoFarm())).toEqual(fences);
  });

  test('closed counter-clockwise rectangles of the documented size around the entrance', () => {
    for (const [i, g] of fences.entries()) {
      const ring = g.geofence.coordinates[0] as LngLat[];
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      let area = 0;
      for (let k = 0; k < 4; k++) {
        const p = ring[k] as LngLat;
        const q = ring[k + 1] as LngLat;
        area += p[0] * q[1] - q[0] * p[1];
      }
      expect(area).toBeGreaterThan(0);
      const sides = [0, 1].map((k) => localDistance(ring[k] as LngLat, ring[k + 1] as LngLat));
      expect(sides.sort((a, b) => a - b)).toEqual([
        expect.closeTo(ENTRANCE_ROAD_SIDE_M + ENTRANCE_FIELD_SIDE_M, 0),
        expect.closeTo(2 * ENTRANCE_ALONG_M, 0),
      ]);
      const b = bbox(ring);
      const [ex, ey] = (farm.fields[i] as (typeof farm.fields)[number]).entrance;
      expect(ex).toBeGreaterThan(b.w);
      expect(ex).toBeLessThan(b.e);
      expect(ey).toBeGreaterThan(b.s);
      expect(ey).toBeLessThan(b.n);
    }
  });

  test('stops short of the crop: no corner inside any field', () => {
    const fieldBoxes = farm.fields.map((f) => bbox(f.boundary.coordinates[0]?.[0] ?? []));
    for (const g of fences) {
      for (const [x, y] of g.geofence.coordinates[0] as LngLat[]) {
        for (const fb of fieldBoxes) {
          const inside = x > fb.w && x < fb.e && y > fb.s && y < fb.n;
          expect(inside).toBe(false);
        }
      }
    }
  });
});
