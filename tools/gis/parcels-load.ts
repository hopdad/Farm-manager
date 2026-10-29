/**
 * Load mapped parcels into gis.parcels + gis.parcel_imports (plan 1d, D7), in ONE transaction:
 *
 *  1. the import row: a new one per file; the same file again (same source + sha256) reuses its
 *     row, so a re-run changes nothing;
 *  2. upsert by (county_fips, parcel_no) in batches, with deterministic ids
 *     (`parcelId(county, number)`); geometries are made valid (ST_MakeValid, polygons only) and
 *     merged features unioned. A row whose values didn't change is not touched, so `updated_at`
 *     (and with it the tiles' `?v=` version) moves only when the data did;
 *  3. `--replace`: parcels of the file's counties that this import didn't write are deleted (a
 *     newer full-county file retires split and merged parcels); without it they are counted only;
 *  4. the `parcels` registry row gets the vintage, build time and import id;
 *  5. realtime, delivered on commit: `layers`/`updated { key: 'parcels', version }` (the rail
 *     re-adds the layer) and `fields`/`updated { parts: ['parcels'] }` for each field whose
 *     parcels changed (`fields`/`invalidate` past MAX_FIELD_MESSAGES).
 */
import type pg from 'pg';
import { TILE_LAYERS } from '../../src/app/api/tiles/layers';
import { publish } from '../../src/platform/realtime/publish';
import type { ParcelRecord } from './parcels-map';

export interface ParcelImportMeta {
  /** 'synthetic', a county ('lenawee-county'), or a vendor ('regrid', 'reportall'). */
  source: string;
  /** The file's county when it has one (null for a multi-county vendor file). */
  countyFips: string | null;
  receivedOn: string | null;
  licenseNote: string;
  fileName: string | null;
  sha256: string;
  notes?: string | null;
  /** gis.map_layers.source_vintage, e.g. 'Lenawee County, received 2027-01-05'. */
  vintage: string;
  /** gis.map_layers.attribution, e.g. 'Parcels: Lenawee County Equalization'. */
  attribution?: string | null;
}

export interface LoadOptions {
  replace?: boolean;
  /** Rows per insert statement (default 500). */
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface LoadSummary {
  importId: string;
  reusedImport: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows of these counties this import didn't write (deleted with --replace). */
  stale: number;
  deleted: number;
  /** Fields whose parcels changed. */
  fieldsAffected: number;
  version: string;
}

/** More affected fields than this: one `fields`/`invalidate` instead of a message per field. */
export const MAX_FIELD_MESSAGES = 50;

const UPSERT_SQL = `
  with src as (
    select r.id, r.county_fips, r.parcel_no, r.owner_name, r.owner_mailing, r.property_address,
           r.acres, r.attrs,
           extensions.ST_Multi(extensions.ST_CollectionExtract(extensions.ST_MakeValid(
             case when r.parts > 1
                  then extensions.ST_UnaryUnion(extensions.ST_MakeValid(
                         extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(r.geom), 4326)))
                  else extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(r.geom), 4326) end), 3))
             as geom
      from jsonb_to_recordset($1::jsonb) as r(
             id uuid, county_fips text, parcel_no text, owner_name text, owner_mailing text,
             property_address text, acres numeric, attrs jsonb, geom text, parts int)
  )
  insert into gis.parcels as p (id, import_id, county_fips, parcel_no, owner_name, owner_mailing,
                                property_address, acres, attrs, geom)
  select src.id, $2::uuid, src.county_fips, src.parcel_no, src.owner_name, src.owner_mailing,
         src.property_address, src.acres, src.attrs, src.geom
    from src
   where not extensions.ST_IsEmpty(src.geom)
  on conflict (county_fips, parcel_no) do update
     set import_id = excluded.import_id,
         owner_name = excluded.owner_name,
         owner_mailing = excluded.owner_mailing,
         property_address = excluded.property_address,
         acres = excluded.acres,
         attrs = excluded.attrs,
         geom = excluded.geom,
         updated_at = now()
   where (p.import_id, p.owner_name, p.owner_mailing, p.property_address, p.acres, p.attrs)
           is distinct from
         (excluded.import_id, excluded.owner_name, excluded.owner_mailing,
          excluded.property_address, excluded.acres, excluded.attrs)
      or not extensions.ST_Equals(p.geom, excluded.geom)
  returning p.id::text as id, (xmax = 0) as inserted`;

function batchJson(records: readonly ParcelRecord[]): string {
  return JSON.stringify(
    records.map((r) => ({
      id: r.id,
      county_fips: r.countyFips,
      parcel_no: r.parcelNo,
      owner_name: r.ownerName,
      owner_mailing: r.ownerMailing,
      property_address: r.propertyAddress,
      acres: r.acres,
      attrs: r.attrs,
      geom: JSON.stringify(r.geometry),
      parts: r.parts,
    })),
  );
}

/** Fields (current boundaries) touching any of these parcels. */
async function fieldsTouching(c: pg.PoolClient, parcelIds: readonly string[]): Promise<string[]> {
  if (parcelIds.length === 0) return [];
  const r = await c.query<{ field_id: string }>(
    `select distinct b.field_id::text as field_id
       from gis.parcels p
       join farm.current_boundaries b on extensions.ST_Intersects(b.geom, p.geom)
      where p.id = any($1::uuid[])
      order by 1`,
    [parcelIds],
  );
  return r.rows.map((x) => x.field_id);
}

export async function loadParcels(
  pool: pg.Pool,
  records: readonly ParcelRecord[],
  meta: ParcelImportMeta,
  opts: LoadOptions = {},
): Promise<LoadSummary> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 500;
  const counties = [...new Set(records.map((r) => r.countyFips))].sort();
  const c = await pool.connect();
  try {
    await c.query('begin');
    const prior = await c.query<{ id: string }>(
      `select id::text from gis.parcel_imports where source = $1 and sha256 = $2
        order by imported_at desc limit 1`,
      [meta.source, meta.sha256],
    );
    let importId = prior.rows[0]?.id ?? null;
    const reusedImport = importId !== null;
    if (!importId) {
      const ins = await c.query<{ id: string }>(
        `insert into gis.parcel_imports
           (source, county_fips, received_on, license_note, file_name, sha256, feature_count, notes)
         values ($1, $2, $3::date, $4, $5, $6, $7, $8)
         returning id::text`,
        [
          meta.source,
          meta.countyFips,
          meta.receivedOn,
          meta.licenseNote,
          meta.fileName,
          meta.sha256,
          records.length,
          meta.notes ?? null,
        ],
      );
      importId = ins.rows[0]?.id as string;
    }

    let inserted = 0;
    let updated = 0;
    const changedIds: string[] = [];
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const r = await c.query<{ id: string; inserted: boolean }>(UPSERT_SQL, [
        batchJson(batch),
        importId,
      ]);
      for (const row of r.rows) {
        changedIds.push(row.id);
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
      log(`parcels ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }

    const staleRows = await c.query<{ id: string }>(
      `select id::text from gis.parcels
        where county_fips = any($1::text[]) and not (id = any($2::uuid[]))`,
      [counties, records.map((r) => r.id)],
    );
    const staleIds = staleRows.rows.map((r) => r.id);
    // Fields next to retired parcels change too: find them before the rows go.
    const affected = new Set(
      await fieldsTouching(c, [...changedIds, ...(opts.replace ? staleIds : [])]),
    );
    let deleted = 0;
    if (opts.replace && staleIds.length > 0) {
      const d = await c.query(`delete from gis.parcels where id = any($1::uuid[])`, [staleIds]);
      deleted = d.rowCount ?? 0;
    }

    await c.query(
      `update gis.map_layers
          set source_vintage = $1, built_at = now(), attribution = coalesce($2, attribution),
              meta = meta || jsonb_build_object('importId', $3::text, 'source', $4::text,
                                                'counties', $5::jsonb),
              updated_at = now()
        where key = 'parcels'`,
      [meta.vintage, meta.attribution ?? null, importId, meta.source, JSON.stringify(counties)],
    );

    const version = await TILE_LAYERS.parcels.version(c);
    const changed = changedIds.length > 0 || deleted > 0;
    if (changed) {
      await publish('layers', 'updated', { key: 'parcels', version }, c);
      const fieldIds = [...affected].sort();
      if (fieldIds.length > MAX_FIELD_MESSAGES) {
        await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, c);
      } else {
        for (const fieldId of fieldIds) {
          await publish('fields', 'updated', { fieldId, parts: ['parcels'] }, c);
        }
      }
    }
    await c.query('commit');
    return {
      importId,
      reusedImport,
      inserted,
      updated,
      unchanged: records.length - inserted - updated,
      stale: staleIds.length,
      deleted,
      fieldsAffected: changed ? affected.size : 0,
      version,
    };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
