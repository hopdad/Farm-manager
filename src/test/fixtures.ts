/**
 * Small geometry and row fixtures for DB tests (no simulator dependency).
 */
import type { MultiPolygon } from 'geojson';
import type { Db } from '../db/client';
import { farms, fieldBoundaries, fields } from '../db/schema';

/** Metres per degree of latitude / longitude on WGS84 at `latDeg` (standard series). */
export function metresPerDegree(latDeg: number): { lat: number; lng: number } {
  const φ = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ),
    lng: 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ),
  };
}

/** A square of `sideMetres` with its south-west corner at (lng, lat), as a MultiPolygon. */
export function squareMultiPolygon(lng: number, lat: number, sideMetres: number): MultiPolygon {
  const m = metresPerDegree(lat + sideMetres / 2 / 111_000);
  const dLat = sideMetres / m.lat;
  const dLng = sideMetres / m.lng;
  return {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [lng, lat],
          [lng + dLng, lat],
          [lng + dLng, lat + dLat],
          [lng, lat + dLat],
          [lng, lat],
        ],
      ],
    ],
  };
}

/** Half a mile in metres: a quarter section is HALF_MILE x HALF_MILE = 160 acres. */
export const HALF_MILE_M = 804.672;

/** A quarter section just west of Adrian, MI (Lenawee County). */
export const ADRIAN_QUARTER_SECTION = squareMultiPolygon(-84.06, 41.89, HALF_MILE_M);

/** Web-mercator tile containing (lng, lat) at zoom z. */
export function tileFor(lng: number, lat: number, z: number): { z: number; x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const φ = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n);
  return { z, x, y };
}

/** Insert a farm + field (+ optional boundary) and return their ids. */
export async function insertField(
  db: Db,
  opts: {
    name?: string;
    geom?: MultiPolygon;
    tenure?: 'owned' | 'cash_rent' | 'share' | 'custom';
  } = {},
): Promise<{ farmId: string; fieldId: string; boundaryId: string | null }> {
  const [farm] = await db.insert(farms).values({ name: 'Home farm' }).returning({ id: farms.id });
  if (!farm) throw new Error('farm insert failed');
  const [field] = await db
    .insert(fields)
    .values({
      farmId: farm.id,
      name: opts.name ?? 'Test 160',
      tenure: opts.tenure ?? 'owned',
      countyFips: '26091',
    })
    .returning({ id: fields.id });
  if (!field) throw new Error('field insert failed');
  let boundaryId: string | null = null;
  if (opts.geom) {
    const [b] = await db
      .insert(fieldBoundaries)
      .values({ fieldId: field.id, geom: opts.geom, source: 'import' })
      .returning({ id: fieldBoundaries.id });
    boundaryId = b?.id ?? null;
  }
  return { farmId: farm.id, fieldId: field.id, boundaryId };
}
