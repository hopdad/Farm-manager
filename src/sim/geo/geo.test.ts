import { describe, expect, test } from 'vitest';
import { fromGeoRef, toGeoRef } from './georef';
import { localDistance, MILE_M, offsetLngLat, toLngLatHeading, trueBearing } from './lnglat';
import {
  angleDiff,
  clipLineConvex,
  dirOf,
  headingOf,
  Path,
  pointInPolygon,
  signedDistanceToRing,
  vec,
} from './vec';

describe('EPSG:3078 (Michigan GeoRef)', () => {
  test('matches PostGIS ST_Transform at a reference point (sub-millimetre)', () => {
    // select ST_AsText(ST_Transform(ST_SetSRID(ST_MakePoint(-84.04, 41.9), 4326), 3078))
    const p = toGeoRef(-84.04, 41.9);
    expect(p.x).toBeCloseTo(662494.4896774434, 3);
    expect(p.y).toBeCloseTo(151915.86608300358, 3);
  });

  test('inverse round-trips across the demo area to a micrometre', () => {
    for (let lng = -84.45; lng <= -83.1; lng += 0.15) {
      for (let lat = 41.65; lat <= 42.15; lat += 0.1) {
        const p = toGeoRef(lng, lat);
        const [lng2, lat2] = fromGeoRef(p.x, p.y);
        expect(Math.abs(lng2 - lng)).toBeLessThan(1e-9);
        expect(Math.abs(lat2 - lat)).toBeLessThan(1e-9);
      }
    }
  });

  test('is metric: a mile on the ground is a mile on the grid (scale ~0.9996-1.0)', () => {
    const a: [number, number] = [-83.9, 41.9];
    const b = offsetLngLat(a, 0, MILE_M);
    const pa = toGeoRef(a[0], a[1]);
    const pb = toGeoRef(b[0], b[1]);
    const grid = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    expect(grid / MILE_M).toBeGreaterThan(0.999);
    expect(grid / MILE_M).toBeLessThan(1.001);
  });

  test('grid heading converts to true heading (north stays north, east stays east)', () => {
    const p = toGeoRef(-83.9, 41.9);
    const north = toGeoRef(-83.9, 41.91);
    const gridNorth = headingOf({ x: north.x - p.x, y: north.y - p.y });
    // Convergence in the demo area is a degree or two.
    expect(Math.abs(angleDiff(0, gridNorth))).toBeLessThan(3);
    expect(Math.abs(angleDiff(0, toLngLatHeading(p, gridNorth).heading))).toBeLessThan(0.05);
    const east = toGeoRef(-83.89, 41.9);
    const gridEast = headingOf({ x: east.x - p.x, y: east.y - p.y });
    expect(toLngLatHeading(p, gridEast).heading).toBeCloseTo(90, 1);
  });
});

describe('lng/lat helpers', () => {
  test('offset, distance and bearing agree', () => {
    const a: [number, number] = [-84, 41.9];
    const b = offsetLngLat(a, 300, 400);
    expect(localDistance(a, b)).toBeCloseTo(500, 1);
    expect(trueBearing(a, b)).toBeCloseTo((Math.atan2(300, 400) * 180) / Math.PI, 2);
    expect(trueBearing(b, a)).toBeCloseTo(180 + (Math.atan2(300, 400) * 180) / Math.PI, 2);
  });
});

describe('planar helpers', () => {
  const square = [vec(0, 0), vec(10, 0), vec(10, 10), vec(0, 10)];

  test('headings and directions', () => {
    expect(headingOf(vec(0, 1))).toBe(0);
    expect(headingOf(vec(1, 0))).toBe(90);
    expect(headingOf(vec(0, -1))).toBe(180);
    expect(headingOf(vec(-1, 0))).toBe(270);
    expect(dirOf(90).x).toBeCloseTo(1);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
  });

  test('point in polygon and signed distance', () => {
    expect(pointInPolygon(vec(5, 5), square)).toBe(true);
    expect(pointInPolygon(vec(11, 5), square)).toBe(false);
    expect(signedDistanceToRing(vec(5, 5), square)).toBe(-5);
    expect(signedDistanceToRing(vec(13, 5), square)).toBe(3);
  });

  test('convex clipping works for both ring orientations', () => {
    expect(clipLineConvex(vec(-5, 5), vec(1, 0), square)).toEqual([5, 15]);
    expect(clipLineConvex(vec(-5, 5), vec(1, 0), [...square].reverse())).toEqual([5, 15]);
    expect(clipLineConvex(vec(-5, 20), vec(1, 0), square)).toBeNull();
  });

  test('Path: arc length lookup, headings, vertices', () => {
    const p = new Path([vec(0, 0), vec(0, 10), vec(0, 10), vec(10, 10)]);
    expect(p.length).toBe(20);
    expect(p.pts).toHaveLength(3);
    expect(p.at(5)).toEqual(vec(0, 5));
    expect(p.at(15)).toEqual(vec(5, 10));
    expect(p.at(99)).toEqual(vec(10, 10));
    expect(p.headingAt(5)).toBe(0);
    expect(p.headingAt(15)).toBe(90);
    expect(p.verticesBetween(0, 20)).toEqual([10]);
    expect(p.verticesBetween(10, 20)).toEqual([]);
    expect(p.verticesBetween(2, 9)).toEqual([]);
  });
});
