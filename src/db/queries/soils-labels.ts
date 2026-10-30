/**
 * Soil map unit label points (owner: soils; route GET /api/soils/labels, contract in
 * src/ui/map/layers/soils-labels.ts). One point per gis.soil_polygons row that meets the bbox,
 * computed in the query (no table, no migration):
 *
 *  - the centre of the polygon's largest inscribed circle (ST_MaximumInscribedCircle, PostGIS
 *    3.1+ built with GEOS 3.9+): the roomiest spot, where the symbol reads best, even in an
 *    L-shaped or ring-like map unit; with an older GEOS, ST_PointOnSurface (always inside, less
 *    central). The GEOS version is read in the same statement, so the query runs on either.
 *  - for the WHOLE polygon, not its part in the bbox: the point never moves as the map pans.
 *  - polygons too small to carry a label at the zoom are skipped (`minAreaDeg2`), the rest
 *    ranked by area, largest first, at most `limit` (one more is read to tell `truncated`).
 *
 * Polygons are valid (gis:soils loads them through ST_MakeValid); both functions are cheap
 * (about 10 ms for 800 polygons of 300 vertices on the dev container).
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

const SQL = `
  with box as (
    select extensions.ST_MakeEnvelope($1, $2, $3, $4, 4326) as g
  ),
  cand as (
    select p.id, p.mukey, p.geom, extensions.ST_Area(p.geom) as area
      from gis.soil_polygons p
     cross join box
     where p.geom && box.g
       and extensions.ST_Intersects(p.geom, box.g)
       and extensions.ST_Area(p.geom) >= $5
     order by extensions.ST_Area(p.geom) desc, p.id
     limit $6
  ),
  geos as (
    select ${GEOS_HAS_MIC_SQL} as mic
  )
  select c.id::text as id, c.mukey, u.musym, u.muname,
         extensions.ST_X(pt.g) as lng, extensions.ST_Y(pt.g) as lat
    from cand c
    join gis.soil_mapunits u on u.mukey = c.mukey
   cross join geos
   cross join lateral (
     select case when geos.mic then (extensions.ST_MaximumInscribedCircle(c.geom)).center
                 else extensions.ST_PointOnSurface(c.geom) end as g
   ) pt
   order by c.area desc, c.id`;

interface Row {
  id: string;
  mukey: string;
  musym: string | null;
  muname: string;
  lng: number;
  lat: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function soilLabels(ex: Queryable, input: SoilLabelsInput): Promise<SoilLabelsResult> {
  const { bbox, minAreaDeg2, limit } = input;
  const r = await ex.query<Row>(SQL, [
    bbox.west,
    bbox.south,
    bbox.east,
    bbox.north,
    minAreaDeg2,
    limit + 1,
  ]);
  const rows = r.rows.slice(0, limit);
  return {
    truncated: r.rows.length > limit,
    features: rows.map((x, rank) => ({
      type: 'Feature',
      id: x.id,
      geometry: { type: 'Point', coordinates: [r6(x.lng), r6(x.lat)] },
      properties: { mukey: x.mukey, musym: x.musym, muname: x.muname, rank },
    })),
  };
}

/** Does this database's PostGIS have the maximum inscribed circle (GEOS 3.9+)? */
export async function geosHasInscribedCircle(ex: Queryable): Promise<boolean> {
  const r = await ex.query<{ mic: boolean }>(`select ${GEOS_HAS_MIC_SQL} as mic`);
  return r.rows[0]?.mic === true;
}
