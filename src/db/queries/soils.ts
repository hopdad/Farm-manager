/**
 * Soils reads (owner: soils; contract docs/contracts-m1.md §5.2). gis.field_soils is written only
 * by gis.rebuild_field_soils (trigger on every boundary version, and `pnpm gis:soils` after a
 * load); these are the app's reads of it.
 *
 *  - fieldSoils(ex, fieldId): the soils of the field's CURRENT boundary as FieldSoilRow[],
 *    largest first: the shape of FieldDetail.soils (the field panel's Soils tab), for any caller
 *    that needs a field's soils without the whole detail (the integrator may point the field
 *    detail query here instead of its inline copy).
 *  - soilsLayerInfo(ex): what is loaded (version, vintage, synthetic or not, counts), from
 *    gis.map_layers 'soils' and the tables.
 */

import type { FieldSoilRow } from '../../domain/soils';
import type { Queryable } from '../client';

interface Row {
  mukey: string;
  musym: string | null;
  muname: string;
  dominant_component: string | null;
  drainage_class: string | null;
  hydgrp: string | null;
  farmland_class: string | null;
  nccpi: number | null;
  acres: string;
  pct: string;
}

export async function fieldSoils(ex: Queryable, fieldId: string): Promise<FieldSoilRow[]> {
  const r = await ex.query<Row>(
    `select fs.mukey, mu.musym, mu.muname, mu.dominant_component, mu.drainage_class, mu.hydgrp,
            mu.farmland_class, round(mu.nccpi::numeric, 3)::double precision as nccpi,
            round(fs.acres, 2)::text as acres, round(fs.pct, 2)::text as pct
       from farm.current_boundaries b
       join gis.field_soils fs on fs.boundary_id = b.id
       join gis.soil_mapunits mu on mu.mukey = fs.mukey
      where b.field_id = $1::uuid
      order by fs.acres desc, fs.mukey`,
    [fieldId],
  );
  return r.rows.map((x) => ({
    mukey: x.mukey,
    musym: x.musym,
    muname: x.muname,
    dominantComponent: x.dominant_component,
    drainageClass: x.drainage_class,
    hydgrp: x.hydgrp,
    farmlandClass: x.farmland_class,
    nccpi: x.nccpi,
    acres: Number(x.acres),
    pct: Number(x.pct),
  }));
}

export interface SoilsLayerInfo {
  /** gis.map_layers 'soils'.version, set by `pnpm gis:soils`; null before any load. */
  version: string | null;
  sourceVintage: string | null;
  builtAt: string | null;
  /** True when the synthetic fixture is what's loaded. */
  fixture: boolean;
  mapunits: number;
  polygons: number;
}

export async function soilsLayerInfo(ex: Queryable): Promise<SoilsLayerInfo> {
  const r = await ex.query<{
    version: string | null;
    source_vintage: string | null;
    built_at: Date | null;
    fixture: string | null;
    mapunits: string;
    polygons: string;
  }>(
    `select l.version, l.source_vintage, l.built_at, l.meta->>'fixture' as fixture,
            (select count(*) from gis.soil_mapunits) as mapunits,
            (select count(*) from gis.soil_polygons) as polygons
       from (select 1) one
       left join gis.map_layers l on l.key = 'soils'`,
  );
  const row = r.rows[0];
  return {
    version: row?.version ?? null,
    sourceVintage: row?.source_vintage ?? null,
    builtAt: row?.built_at ? row.built_at.toISOString() : null,
    fixture: row?.fixture === 'true',
    mapunits: Number(row?.mapunits ?? 0),
    polygons: Number(row?.polygons ?? 0),
  };
}
