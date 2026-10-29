/**
 * Load phase of `pnpm gis:soils`: one run directory (./soils-raw.ts) → gis.soil_mapunits,
 * gis.soil_polygons, gis.field_soils, the `soils` row of gis.map_layers, and realtime. Owner:
 * soils. The same code serves a fresh download, `--offline` (any cached run) and `--fixture`.
 *
 * One transaction (readers see the old soils or the new, never half), under an advisory lock so
 * two loads never interleave:
 *   1. map units of every area in the run (upsert on mukey; unchanged rows are not rewritten)
 *   2. polygons, file by file, into a temp table; then made valid (ST_MakeValid → polygons only
 *      → MultiPolygon, plan §4 "Geometries are valid") and upserted on (source, source_id =
 *      SDA mupolygonkey); unchanged rows are not rewritten
 *   3. polygons and map units of those areas that the run no longer has are deleted (a survey
 *      update retires them); `field_soils` follows by cascade
 *   4. gis.map_layers 'soils': version (a hash of the run's files: the same data gives the same
 *      tile URLs), vintage, attribution, meta
 *   5. gis.rebuild_all_field_soils() (contract §3.2), then realtime: `layers`/`updated`, and
 *      `fields`/`updated` (parts ['soils']) for each field whose current soils changed, or one
 *      `fields`/`invalidate` when that is more than PER_FIELD_PUBLISH_MAX fields
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type pg from 'pg';
import { publish } from '../../src/platform/realtime/publish';
import {
  buildMapunitRecords,
  type ComponentRow,
  type MapunitRecord,
  type MapunitStatsRow,
  type SurveyAreaRow,
  surveyVersion,
  toComponentRows,
  toMapunitStatsRows,
  toPolygonRows,
  toSurveyAreaRows,
} from './soils-model';
import type { RunFile, SoilsRun } from './soils-raw';
import { parseSdaBody, sdaRecords } from './soils-sda';

export const SOILS_LAYER_KEY = 'soils';
export const SOILS_SOURCE = 'ssurgo';
export const SOILS_ATTRIBUTION = 'Soils: USDA NRCS SSURGO';
export const FIXTURE_ATTRIBUTION = 'Soils: synthetic test fixture (not USDA data)';
/** More changed fields than this get one `fields`/`invalidate` instead of one message each. */
export const PER_FIELD_PUBLISH_MAX = 100;
const INSERT_CHUNK = 1000;

export interface LoadOptions {
  log?: (msg: string) => void;
  /** Load a synthetic fixture over real SSURGO data (normally refused). */
  force?: boolean;
}

export interface Counts {
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

export interface LoadReport {
  version: string;
  fixture: boolean;
  areas: string[];
  mapunits: Counts;
  polygons: Counts & { invalid: number };
  fieldSoilsRows: number;
  changedFields: string[];
}

/** Layer version of a run: a hash of its files' checksums (same data → same tile URLs). */
export function soilsVersion(run: SoilsRun): string {
  const h = createHash('sha256');
  for (const f of [...run.index.files].sort((a, b) => a.file.localeCompare(b.file))) {
    h.update(`${f.file}:${f.sha256}\n`);
  }
  return `${run.index.fixture ? 'fixture' : 'ssurgo'}-${h.digest('hex').slice(0, 12)}`;
}

async function tableOf(run: SoilsRun, f: RunFile) {
  return sdaRecords(parseSdaBody(await run.read(f)));
}

interface AreaTables {
  stats: MapunitStatsRow[];
  components: ComponentRow[];
  polygonFiles: RunFile[];
}

/** Survey rows and, per area, its map units, components and polygon files (in run order). */
export async function readRunTables(
  run: SoilsRun,
): Promise<{ survey: SurveyAreaRow[]; areas: Map<string, AreaTables> }> {
  const survey: SurveyAreaRow[] = [];
  const areas = new Map<string, AreaTables>(
    run.index.areas.map((a) => [a, { stats: [], components: [], polygonFiles: [] }]),
  );
  for (const f of run.index.files) {
    if (f.kind === 'survey') {
      survey.push(...toSurveyAreaRows(await tableOf(run, f)));
      continue;
    }
    const area = f.area ? areas.get(f.area) : undefined;
    if (!area) throw new Error(`run file ${f.file} names area ${f.area}, not in the run`);
    if (f.kind === 'stats') area.stats.push(...toMapunitStatsRows(await tableOf(run, f)));
    else if (f.kind === 'components')
      area.components.push(...toComponentRows(await tableOf(run, f)));
    else area.polygonFiles.push(f);
  }
  for (const [a, t] of areas) {
    if (t.stats.length === 0) throw new Error(`run has no map units for ${a}`);
  }
  return { survey, areas };
}

const MAPUNIT_UPSERT = `
  insert into gis.soil_mapunits as m
    (mukey, areasymbol, musym, muname, dominant_component, drainage_class, hydgrp,
     farmland_class, nccpi, components, survey_version, loaded_at)
  select r.mukey, r.areasymbol, r.musym, r.muname, r.dominant_component, r.drainage_class,
         r.hydgrp, r.farmland_class, r.nccpi, coalesce(r.components, '[]'::jsonb),
         r.survey_version, now()
    from jsonb_to_recordset($1::jsonb) as r(
           mukey text, areasymbol text, musym text, muname text, dominant_component text,
           drainage_class text, hydgrp text, farmland_class text, nccpi double precision,
           components jsonb, survey_version text)
  on conflict (mukey) do update
     set areasymbol = excluded.areasymbol, musym = excluded.musym, muname = excluded.muname,
         dominant_component = excluded.dominant_component,
         drainage_class = excluded.drainage_class, hydgrp = excluded.hydgrp,
         farmland_class = excluded.farmland_class, nccpi = excluded.nccpi,
         components = excluded.components, survey_version = excluded.survey_version,
         loaded_at = now()
   where (m.areasymbol, m.musym, m.muname, m.dominant_component, m.drainage_class, m.hydgrp,
          m.farmland_class, m.nccpi, m.components, m.survey_version)
         is distinct from
         (excluded.areasymbol, excluded.musym, excluded.muname, excluded.dominant_component,
          excluded.drainage_class, excluded.hydgrp, excluded.farmland_class, excluded.nccpi,
          excluded.components, excluded.survey_version)
  returning (xmax = 0) as inserted`;

function mapunitJson(r: MapunitRecord) {
  return {
    mukey: r.mukey,
    areasymbol: r.areasymbol,
    musym: r.musym,
    muname: r.muname,
    dominant_component: r.dominantComponent,
    drainage_class: r.drainageClass,
    hydgrp: r.hydgrp,
    farmland_class: r.farmlandClass,
    nccpi: r.nccpi,
    components: r.components,
    survey_version: r.surveyVersion,
  };
}

const POLYGON_UPSERT = `
  insert into gis.soil_polygons as p (mukey, areasymbol, geom, source, source_id, loaded_at)
  select s.mukey, s.areasymbol, s.geom, '${SOILS_SOURCE}', s.source_id, now()
    from soils_src s
  on conflict (source, source_id) do update
     set mukey = excluded.mukey, areasymbol = excluded.areasymbol, geom = excluded.geom,
         loaded_at = now()
   where p.mukey is distinct from excluded.mukey
      or p.areasymbol is distinct from excluded.areasymbol
      or extensions.ST_AsBinary(p.geom) is distinct from extensions.ST_AsBinary(excluded.geom)
  returning (xmax = 0) as inserted`;

const FIELD_SOILS_HASH = `
  select boundary_id,
         md5(string_agg(mukey || ':' || acres::text || ':' || pct::text, ',' order by mukey)) as h
    from gis.field_soils group by boundary_id`;

/** Load `run` into the database `pool` points at. */
export async function loadSoilsRun(
  pool: pg.Pool,
  run: SoilsRun,
  opts: LoadOptions = {},
): Promise<LoadReport> {
  const log = opts.log ?? (() => {});
  const fixture = run.index.fixture !== undefined;
  const version = soilsVersion(run);
  const { survey, areas } = await readRunTables(run);
  const areaList = [...areas.keys()].sort();

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('gis:soils'))`);

    // Never let the synthetic fixture replace real survey data by accident.
    if (fixture && !opts.force) {
      const cur = await client.query<{ fixture: string | null; polygons: string }>(
        `select (select meta->>'fixture' from gis.map_layers where key = $1) as fixture,
                (select count(*) from gis.soil_polygons where areasymbol = any($2::text[])) as polygons`,
        [SOILS_LAYER_KEY, areaList],
      );
      const row = cur.rows[0];
      if (row && row.fixture === 'false' && Number(row.polygons) > 0) {
        throw new Error(
          'the database has real SSURGO soils; loading the synthetic fixture would replace them (use --force to do it anyway)',
        );
      }
    }

    // 1. Map units.
    const mapunits: Counts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
    const allMukeys: string[] = [];
    for (const area of areaList) {
      const t = areas.get(area) as AreaTables;
      const records = buildMapunitRecords(
        area,
        survey.find((s) => s.areasymbol === area),
        t.stats,
        t.components,
      );
      for (let i = 0; i < records.length; i += INSERT_CHUNK) {
        const chunk = records.slice(i, i + INSERT_CHUNK);
        const r = await client.query<{ inserted: boolean }>(MAPUNIT_UPSERT, [
          JSON.stringify(chunk.map(mapunitJson)),
        ]);
        const ins = r.rows.filter((x) => x.inserted).length;
        mapunits.inserted += ins;
        mapunits.updated += r.rows.length - ins;
        mapunits.unchanged += chunk.length - r.rows.length;
      }
      allMukeys.push(...records.map((r) => r.mukey));
    }

    // 2. Polygons into a temp table, file by file (a county is tens of MB of WKT).
    await client.query(
      `create temp table soils_load (
         source_id text primary key, mukey text not null, areasymbol text not null,
         wkt text not null) on commit drop`,
    );
    const known = new Set(allMukeys);
    for (const area of areaList) {
      for (const f of (areas.get(area) as AreaTables).polygonFiles) {
        const rows = toPolygonRows(await tableOf(run, f));
        for (const r of rows) {
          if (!known.has(r.mukey)) {
            throw new Error(`${f.file}: polygon ${r.mupolygonkey} has unknown mukey ${r.mukey}`);
          }
        }
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const chunk = rows.slice(i, i + INSERT_CHUNK);
          await client.query(
            `insert into soils_load (source_id, mukey, areasymbol, wkt)
             select * from unnest($1::text[], $2::text[], $3::text[], $4::text[])
             on conflict (source_id) do nothing`,
            [
              chunk.map((r) => r.mupolygonkey),
              chunk.map((r) => r.mukey),
              chunk.map(() => area),
              chunk.map((r) => r.wkt),
            ],
          );
        }
      }
    }
    await client.query(
      `create temp table soils_src on commit drop as
       select source_id, mukey, areasymbol, geom
         from (select l.source_id, l.mukey, l.areasymbol,
                      extensions.ST_Multi(extensions.ST_CollectionExtract(
                        extensions.ST_MakeValid(extensions.ST_GeomFromText(l.wkt, 4326)), 3)) as geom
                 from soils_load l) g
        where not extensions.ST_IsEmpty(geom)`,
    );
    await client.query('create unique index on soils_src (source_id)');
    const counts = await client.query<{ loaded: string; valid: string }>(
      'select (select count(*) from soils_load) as loaded, (select count(*) from soils_src) as valid',
    );
    const loaded = Number(counts.rows[0]?.loaded ?? 0);
    const valid = Number(counts.rows[0]?.valid ?? 0);
    const polygons: Counts & { invalid: number } = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      invalid: loaded - valid,
    };
    if (polygons.invalid > 0)
      log(`${polygons.invalid} polygon(s) had no area after ST_MakeValid; skipped`);

    // Field soils before, to publish only what changed.
    await client.query(`create temp table soils_before on commit drop as ${FIELD_SOILS_HASH}`);

    const up = await client.query<{ inserted: boolean }>(POLYGON_UPSERT);
    polygons.inserted = up.rows.filter((x) => x.inserted).length;
    polygons.updated = up.rows.length - polygons.inserted;
    polygons.unchanged = valid - up.rows.length;

    // 3. Retire what the survey no longer has.
    const delPolys = await client.query(
      `delete from gis.soil_polygons p
        where p.source = '${SOILS_SOURCE}' and p.areasymbol = any($1::text[])
          and not exists (select 1 from soils_src s where s.source_id = p.source_id)`,
      [areaList],
    );
    polygons.deleted = delPolys.rowCount ?? 0;
    const delUnits = await client.query(
      `delete from gis.soil_mapunits m
        where m.areasymbol = any($1::text[]) and not (m.mukey = any($2::text[]))`,
      [areaList, allMukeys],
    );
    mapunits.deleted = delUnits.rowCount ?? 0;

    // 4. The layer registry row.
    const surveyVersions = areaList.map(
      (a) => surveyVersion(survey.find((s) => s.areasymbol === a)) ?? a,
    );
    const vintage = fixture
      ? 'Synthetic fixture (not survey data)'
      : `SSURGO ${surveyVersions.join(', ')}`;
    await client.query(
      `insert into gis.map_layers
         (key, kind, url_or_key, version, cache_policy, minzoom, maxzoom, attribution,
          source_vintage, built_at, default_visible, meta)
       values ($1, 'mvt', '/api/tiles/soils', $2, 'public', 10, 16, $3, $4, now(), false, $5::jsonb)
       on conflict (key) do update
          set version = excluded.version, attribution = excluded.attribution,
              source_vintage = excluded.source_vintage, built_at = excluded.built_at,
              meta = excluded.meta, updated_at = now()`,
      [
        SOILS_LAYER_KEY,
        version,
        fixture ? FIXTURE_ATTRIBUTION : SOILS_ATTRIBUTION,
        vintage,
        JSON.stringify({
          fixture,
          run: path.basename(run.dir),
          areas: areaList,
          surveyVersions,
          nccpiRule: run.index.nccpiRule,
          service: run.index.service,
          polygons: valid,
          mapunits: allMukeys.length,
        }),
      ],
    );

    // 5. Field soils for every boundary version, then tell the screens.
    const rebuilt = await client.query<{ n: number }>('select gis.rebuild_all_field_soils() as n');
    const changed = await client.query<{ field_id: string }>(
      `with after as (${FIELD_SOILS_HASH})
       select distinct cb.field_id::text as field_id
         from after a
         full join soils_before s using (boundary_id)
         join farm.current_boundaries cb on cb.id = coalesce(a.boundary_id, s.boundary_id)
        where a.h is distinct from s.h
        order by 1`,
    );
    const changedFields = changed.rows.map((r) => r.field_id);
    await publish('layers', 'updated', { key: SOILS_LAYER_KEY, version }, client);
    if (changedFields.length > PER_FIELD_PUBLISH_MAX) {
      await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, client);
    } else {
      for (const fieldId of changedFields) {
        await publish('fields', 'updated', { fieldId, parts: ['soils'] }, client);
      }
    }

    await client.query('commit');
    return {
      version,
      fixture,
      areas: areaList,
      mapunits,
      polygons,
      fieldSoilsRows: Number(rebuilt.rows[0]?.n ?? 0),
      changedFields,
    };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function formatLoadReport(r: LoadReport): string {
  const c = (x: Counts) =>
    `${x.inserted} new, ${x.updated} changed, ${x.unchanged} unchanged, ${x.deleted} retired`;
  return [
    `soils ${r.version}${r.fixture ? ' (SYNTHETIC FIXTURE)' : ''} for ${r.areas.join(', ')}`,
    `  map units  ${c(r.mapunits)}`,
    `  polygons   ${c(r.polygons)}${r.polygons.invalid ? `, ${r.polygons.invalid} empty after repair` : ''}`,
    `  field soils ${r.fieldSoilsRows} rows over every boundary version; ${r.changedFields.length} field(s) changed`,
  ].join('\n');
}
