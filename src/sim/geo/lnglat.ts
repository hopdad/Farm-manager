/**
 * WGS84 helpers for the simulator: metres per degree, offsets, true headings, and conversion of
 * GRID headings (EPSG:3078) to TRUE headings (clockwise from true north) at a point.
 */
import type { LngLat } from '../types';
import { fromGeoRef } from './georef';
import { dirOf, type Vec, wrap360 } from './vec';

/** Statute mile in metres. */
export const MILE_M = 1609.344;
export const MPH_TO_MPS = MILE_M / 3600;
export const FT_M = 0.3048;

/** Metres per degree of latitude / longitude on WGS84 at `latDeg` (standard series). */
export function metresPerDegree(latDeg: number): { lat: number; lng: number } {
  const phi = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    lng: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi),
  };
}

/** Move `p` by `east` / `north` metres (local tangent plane; exact enough below a few km). */
export function offsetLngLat(p: LngLat, east: number, north: number): LngLat {
  const m = metresPerDegree(p[1]);
  return [p[0] + east / m.lng, p[1] + north / m.lat];
}

/** True heading from a to b (local tangent plane), degrees clockwise from north, [0, 360). */
export function trueBearing(a: LngLat, b: LngLat): number {
  const m = metresPerDegree((a[1] + b[1]) / 2);
  const east = (b[0] - a[0]) * m.lng;
  const north = (b[1] - a[1]) * m.lat;
  return wrap360((Math.atan2(east, north) * 180) / Math.PI);
}

/** Local distance in metres between two nearby points (tangent plane). */
export function localDistance(a: LngLat, b: LngLat): number {
  const m = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * m.lng, (b[1] - a[1]) * m.lat);
}

/**
 * Sample-time conversion: EPSG:3078 position + grid heading -> lng/lat + true heading.
 * The true heading is measured from the point to a point 10 m ahead on the grid.
 */
export function toLngLatHeading(p: Vec, gridHeading: number): { lngLat: LngLat; heading: number } {
  const here = fromGeoRef(p.x, p.y);
  const d = dirOf(gridHeading);
  const ahead = fromGeoRef(p.x + d.x * 10, p.y + d.y * 10);
  return { lngLat: here, heading: trueBearing(here, ahead) };
}
