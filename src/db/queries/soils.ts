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
 *  - mapUnitDetail(ex, mukey): one map unit with its components, for the map unit sheet
 *    (GET /api/soils/mapunits/<mukey>, soil map Phase A); null when there is no such map unit.
 */

import type { FieldSoilRow } from '../../domain/soils';
import { type MapUnitDetail, parseComponents } from '../../ui/soils/protocol';
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

export async function mapUnitDetail(ex: Queryable, mukey: string): Promise<MapUnitDetail | null> {
  const r = await ex.query<{
    mukey: string;
    areasymbol: string;
    musym: string | null;
    muname: string;
    dominant_component: string | null;
    drainage_class: string | null;
    hydgrp: string | null;
    farmland_class: string | null;
    nccpi: number | null;
    components: unknown;
    survey_version: string | null;
    fixture: string | null;
  }>(
    `select u.mukey, u.areasymbol, u.musym, u.muname, u.dominant_component, u.drainage_class,
            u.hydgrp, u.farmland_class, round(u.nccpi::numeric, 3)::double precision as nccpi,
            u.components, u.survey_version,
            (select l.meta->>'fixture' from gis.map_layers l where l.key = 'soils') as fixture
       from gis.soil_mapunits u
      where u.mukey = $1`,
    [mukey],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    mukey: x.mukey,
    areasymbol: x.areasymbol,
    musym: x.musym,
    muname: x.muname,
    dominantComponent: x.dominant_component,
    drainageClass: x.drainage_class,
    hydgrp: x.hydgrp,
    farmlandClass: x.farmland_class,
    nccpi: x.nccpi,
    // Largest first; ties keep the stored order (gis:soils writes them by share, then lowest
    // cokey: the same order it picks the dominant component by), so the first one is it.
    components: parseComponents(x.components).sort((a, b) => b.pct - a.pct),
    surveyVersion: x.survey_version,
    synthetic: x.fixture === 'true',
  };
}
