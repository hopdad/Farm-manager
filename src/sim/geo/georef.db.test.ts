/**
 * The simulator's EPSG:3078 projection (src/sim/geo/georef.ts) against PostGIS's ST_Transform
 * on the pinned image, over the whole offline-basemap area: forward within a millimetre, and the
 * inverse of PostGIS's output back to the input within a micrometre-scale tolerance.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { fromGeoRef, toGeoRef } from './georef';

const t = setupTestDb(import.meta.url);

describe('EPSG:3078 vs PostGIS', () => {
  test('forward and inverse agree with ST_Transform', async () => {
    const pts: [number, number][] = [];
    for (let lng = -84.45; lng <= -83.1 + 1e-9; lng += 0.09) {
      for (let lat = 41.65; lat <= 42.15 + 1e-9; lat += 0.05) pts.push([lng, lat]);
    }
    const r = await t().pool.query(
      `select extensions.ST_X(p) as x, extensions.ST_Y(p) as y
         from unnest($1::float8[], $2::float8[]) with ordinality as u(lng, lat, n),
              lateral (select extensions.ST_Transform(
                 extensions.ST_SetSRID(extensions.ST_MakePoint(u.lng, u.lat), 4326), 3078) as p) q
        order by u.n`,
      [pts.map((p) => p[0]), pts.map((p) => p[1])],
    );
    expect(r.rows).toHaveLength(pts.length);
    pts.forEach(([lng, lat], i) => {
      const pg = r.rows[i] as { x: number; y: number };
      const ours = toGeoRef(lng, lat);
      expect(Math.abs(ours.x - pg.x)).toBeLessThan(0.001);
      expect(Math.abs(ours.y - pg.y)).toBeLessThan(0.001);
      const [lng2, lat2] = fromGeoRef(pg.x, pg.y);
      expect(Math.abs(lng2 - lng)).toBeLessThan(1e-8);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-8);
    });
  });
});
