/**
 * Soil map unit label points (owner: soils; route GET /api/soils/labels, contract in
 * src/ui/map/layers/soils-labels.ts). One point per gis.soil_polygons row that meets the bbox,
 * computed by the database (no table, no migration):
 *
 *  - the centre of the polygon's largest inscribed circle (ST_MaximumInscribedCircle, PostGIS
 *    3.1+ built with GEOS 3.9+): the roomiest spot, where the symbol reads best, even in an
 *    L-shaped or ring-like map unit; with an older GEOS, ST_PointOnSurface (always inside, less
 *    central). The GEOS version is read in the same statement, so the query runs on either.
 *  - for the WHOLE polygon, not its part in the bbox: the point never moves as the map pans.
 *  - polygons too small to carry a label at the zoom are skipped (`minAreaDeg2`), the rest
 *    ranked by area, largest first, at most `limit` (one more is read to tell `truncated`).
 *
 * Cost (measured in review on the real Lenawee + Monroe load, 31,445 polygons of up to 20,233
 * vertices, Oct 2026): picking the candidates through the GiST index is cheap (tens of ms), but
 * the inscribed circles of the 800 largest polygons in a wall-sized z13 bbox take about 200 ms
 * (point on surface: about 50 ms). So:
 *
 *  1. one query picks the candidates (id, symbol, name) and reads the soils version;
 *  2. a second computes the points of the candidates not computed before, each ONCE (`offset 0`
 *     keeps Postgres from inlining the subquery and running the circle for ST_X and ST_Y apart);
 *  3. the points are kept in memory for that soils version (a point never moves within one;
 *     `pnpm gis:soils` writes a new version), so pans and zooms over the same farm ask the
 *     database for candidates only.
 *
 * Polygons are valid (gis:soils loads them through ST_MakeValid).
 */
import type { Bbox, SoilLabelFeature } from '../../ui/map/layers/soils-labels';
import type { Queryable } from '../client';

export interface SoilLabelsInput {
  bbox: Bbox;
  /** Smallest polygon labelled, square degrees (EPSG:4326 ST_Area). */
  minAreaDeg2: number;
  limit: number;
}

export interface SoilLabelsResult {
  features: SoilLabelFeature[];
  truncated: boolean;
}

/** GEOS 3.9 or newer has the maximum inscribed circle. */
export const GEOS_HAS_MIC_SQL = `coalesce(
    (string_to_array(substring(extensions.postgis_geos_version() from '^[0-9]+\\.[0-9]+'), '.')::int[])
      >= array[3, 9],
    false)`;

/** $1-$4 bbox, $5 smallest area, $6 how many. */
export const LABEL_CANDIDATES_SQL = `
  with box as (
    select extensions.ST_MakeEnvelope($1, $2, $3, $4, 4326) as g
  ),
  cand as (
    select p.id, p.mukey, extensions.ST_Area(p.geom) as area
      from gis.soil_polygons p
     cross join box
     where p.geom && box.g
       and extensions.ST_Intersects(p.geom, box.g)
       and extensions.ST_Area(p.geom) >= $5
     order by extensions.ST_Area(p.geom) desc, p.id
     limit $6
  )
  select c.id::text as id, c.mukey, u.musym, u.muname,
         (select l.version from gis.map_layers l where l.key = 'soils') as version
    from cand c
    join gis.soil_mapunits u on u.mukey = c.mukey
   order by c.area desc, c.id`;

/** $1 the polygon ids. */
export const LABEL_POINTS_SQL = `
  with geos as (
    select ${GEOS_HAS_MIC_SQL} as mic
  )
  select s.id::text as id, extensions.ST_X(s.g) as lng, extensions.ST_Y(s.g) as lat
    from (
      select p.id,
             case when geos.mic then (extensions.ST_MaximumInscribedCircle(p.geom)).center
                  else extensions.ST_PointOnSurface(p.geom) end as g
        from gis.soil_polygons p
       cross join geos
       where p.id = any($1::uuid[])
      offset 0
    ) s`;

interface CandidateRow {
  id: string;
  mukey: string;
  musym: string | null;
  muname: string;
  version: string | null;
}

type Point = readonly [lng: number, lat: number];

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Points kept at most (the real two-county load is about 31,000 polygons). */
export const LABEL_POINT_MEMO_MAX = 100_000;

/** Label points already computed, for one soils version (this process). */
let memo: { version: string; points: Map<string, Point> } | null = null;

function remembered(version: string | null): Map<string, Point> | null {
  if (version === null) return null;
  if (memo?.version !== version || memo.points.size > LABEL_POINT_MEMO_MAX) {
    memo = { version, points: new Map() };
  }
  return memo.points;
}

/** Forget the computed points (tests). */
export function clearSoilLabelPoints(): void {
  memo = null;
}

export async function soilLabels(ex: Queryable, input: SoilLabelsInput): Promise<SoilLabelsResult> {
  const { bbox, minAreaDeg2, limit } = input;
  const cand = await ex.query<CandidateRow>(LABEL_CANDIDATES_SQL, [
    bbox.west,
    bbox.south,
    bbox.east,
    bbox.north,
    minAreaDeg2,
    limit + 1,
  ]);
  const rows = cand.rows.slice(0, limit);
  // Without a version (no `pnpm gis:soils` yet) nothing tells a reload apart: compute each time.
  const known = remembered(rows[0]?.version ?? null);
  const points = new Map<string, Point>();
  const missing: string[] = [];
  for (const x of rows) {
    const p = known?.get(x.id);
    if (p) points.set(x.id, p);
    else missing.push(x.id);
  }
  if (missing.length > 0) {
    const r = await ex.query<{ id: string; lng: number; lat: number }>(LABEL_POINTS_SQL, [missing]);
    for (const x of r.rows) {
      const p: Point = [r6(x.lng), r6(x.lat)];
      points.set(x.id, p);
      known?.set(x.id, p);
    }
  }
  const features: SoilLabelFeature[] = [];
  for (const x of rows) {
    // A polygon deleted between the two queries (a reload) has no point: it goes unlabelled.
    const p = points.get(x.id);
    if (!p) continue;
    features.push({
      type: 'Feature',
      id: x.id,
      geometry: { type: 'Point', coordinates: [p[0], p[1]] },
      properties: { mukey: x.mukey, musym: x.musym, muname: x.muname, rank: features.length },
    });
  }
  return { truncated: cand.rows.length > limit, features };
}

/** Does this database's PostGIS have the maximum inscribed circle (GEOS 3.9+)? */
export async function geosHasInscribedCircle(ex: Queryable): Promise<boolean> {
  const r = await ex.query<{ mic: boolean }>(`select ${GEOS_HAS_MIC_SQL} as mic`);
  return r.rows[0]?.mic === true;
}
