/**
 * Field panel queries (plan 1a "tap a field"; docs/contracts-m1.md §5.1, §8).
 *
 *  - `fieldDetail()`: everything the panel and its tabs show, as one `FieldDetail`, from ONE
 *    statement (one round trip: the tap-to-panel budget is 200 ms). Every per-field lookup in it
 *    is an index scan (src/db/queries/fields.db.test.ts checks the plan with EXPLAIN on a
 *    500-field farm):
 *      farm.fields pkey · farm.field_boundaries field_boundaries_no_overlap (gist field_id, valid)
 *      · farm.field_seasons (field_id, crop_year) · gis.field_soils pkey (boundary_id, mukey)
 *      · gis.parcels geom gist · farm.field_lineage (parent, child) / child_field_id
 *      · farm.boundary_change_requests open index · farm.spray_assessments (field_id, for_hour).
 *    The JSON is built in SQL with the contract's camelCase keys; timestamps leave as UTC ISO.
 *  - `saveFieldNotes()`: the notes edit (manager+, checked by the caller), optimistic on
 *    `FieldNotes.version` (farm.fields.updated_at, microseconds), publishing `fields`/`updated`
 *    `{ fieldId, parts: ['notes'] }` in the same transaction (delivered on commit).
 */
import {
  boundaryEditPolicy,
  FIELD_PANEL_SEASONS,
  type FieldDetail,
  type FieldNotes,
  type FieldSummary,
} from '../../domain/fields';
import { summarizeFieldSoils } from '../../domain/soils';
import { publish } from '../../platform/realtime/publish';
import type { Db, DbTx } from '../client';
import { type Executor, exec } from '../exec';

/** Parcels touching the boundary by less than this (a shared fence line) are left out. */
export const MIN_PARCEL_OVERLAP_ACRES = 0.01;

/** UTC ISO with milliseconds (what Date#toISOString prints). */
const iso = (expr: string) =>
  `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** UTC ISO with microseconds: FieldNotes.version must round-trip updated_at exactly. */
const isoMicros = (expr: string) =>
  `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ymd = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD')`;
/** A geometry GEOS can overlay: invalid input is repaired first (parcels come from outside). */
const overlayable = (expr: string) =>
  `(case when extensions.ST_IsValid(${expr}) then ${expr}
         else extensions.ST_CollectionExtract(extensions.ST_MakeValid(${expr}), 3) end)`;

const partyJson = (idExpr: string) => `(
  select json_build_object('id', p.id, 'displayName', p.display_name, 'kind', p.kind,
                           'phone', p.phone, 'email', p.email)
    from farm.parties p
   where p.id = ${idExpr})`;

const notesJson = (alias: string) => `json_build_object(
    'text', ${alias}.notes,
    'updatedAt', ${iso(`${alias}.notes_updated_at`)},
    'updatedByName', (select np.display_name
                        from farm.app_users nu
                        join farm.parties np on np.id = nu.party_id
                       where nu.id = ${alias}.notes_updated_by),
    'version', ${isoMicros(`${alias}.updated_at`)})`;

const lineageJson = (joinCol: string, whereCol: string) => `coalesce((
    select json_agg(json_build_object('fieldId', o.id, 'name', o.name, 'kind', l.kind,
                                      'effectiveOn', ${ymd('l.effective_on')})
                    order by l.effective_on desc, o.name)
      from farm.field_lineage l
      join farm.fields o on o.id = l.${joinCol}
     where l.${whereCol} = $1::uuid), '[]'::json)`;

/**
 * The panel's one statement. $1 = field id, $2 = the instant "current" means (the current
 * boundary version, the spray verdict of that hour). No row: no such field.
 */
export const FIELD_DETAIL_SQL = `
with fld as materialized (
  select f.id, f.name, f.farm_id, fa.name as farm_name, f.tenure, f.county_fips,
         f.landlord_party_id, fa.client_party_id, f.deere_field_id, f.active,
         f.notes, f.notes_updated_at, f.notes_updated_by, f.updated_at
    from farm.fields f
    join farm.farms fa on fa.id = f.farm_id
   where f.id = $1::uuid
),
bnd as materialized (
  select b.id, b.geom, b.acres, b.source, b.source_ref, lower(b.valid) as valid_from,
         extensions.box2d(b.geom) as box
    from farm.field_boundaries b
   where b.field_id = $1::uuid and b.valid @> $2::timestamptz
   order by lower(b.valid) desc
   limit 1
)
select json_build_object(
  'field', json_build_object(
    'id', fld.id,
    'name', fld.name,
    'farmId', fld.farm_id,
    'farmName', fld.farm_name,
    'tenure', fld.tenure,
    'acres', (select round(bnd.acres, 2) from bnd),
    'countyFips', fld.county_fips,
    'landlord', ${partyJson('fld.landlord_party_id')},
    'customer', ${partyJson('fld.client_party_id')},
    'deereFieldId', fld.deere_field_id,
    'active', fld.active),
  'boundary', (
    select json_build_object(
      'id', bnd.id,
      'acres', round(bnd.acres, 2),
      'source', bnd.source,
      'sourceRef', bnd.source_ref,
      'validFrom', ${iso('bnd.valid_from')},
      'bbox', json_build_array(
        round(extensions.ST_XMin(bnd.box)::numeric, 6), round(extensions.ST_YMin(bnd.box)::numeric, 6),
        round(extensions.ST_XMax(bnd.box)::numeric, 6), round(extensions.ST_YMax(bnd.box)::numeric, 6)))
      from bnd),
  'seasons', coalesce((
    select json_agg(json_build_object(
             'cropYear', s.crop_year, 'crop', s.crop, 'variety', s.variety,
             'plantedOn', ${ymd('s.planted_on')}, 'harvestedOn', ${ymd('s.harvested_on')},
             'yieldBuAc', s.yield_bu_ac, 'source', s.source)
           order by s.crop_year desc)
      from (select * from farm.field_seasons
             where field_id = $1::uuid
             order by crop_year desc
             limit ${FIELD_PANEL_SEASONS}) s), '[]'::json),
  'soils', coalesce((
    select json_agg(json_build_object(
             'mukey', fs.mukey, 'musym', mu.musym, 'muname', mu.muname,
             'dominantComponent', mu.dominant_component, 'drainageClass', mu.drainage_class,
             'hydgrp', mu.hydgrp, 'farmlandClass', mu.farmland_class,
             'nccpi', round(mu.nccpi::numeric, 3),
             'acres', round(fs.acres, 2), 'pct', round(fs.pct, 2))
           order by fs.acres desc, fs.mukey)
      from bnd
      join gis.field_soils fs on fs.boundary_id = bnd.id
      join gis.soil_mapunits mu on mu.mukey = fs.mukey), '[]'::json),
  'parcels', coalesce((
    select json_agg(json_build_object(
             'id', x.id, 'countyFips', x.county_fips, 'parcelNo', x.parcel_no,
             'ownerName', x.owner_name, 'ownerMailing', x.owner_mailing,
             'propertyAddress', x.property_address, 'acres', round(x.acres, 2),
             'gisAcres', round(x.gis_acres, 2), 'importSource', x.import_source,
             'receivedOn', ${ymd('x.received_on')},
             'overlapAcres', round(x.overlap_acres::numeric, 2),
             'overlapPct', round((100 * x.overlap_acres / nullif(x.field_acres, 0))::numeric, 1))
           order by x.overlap_acres desc, x.parcel_no)
      from (
        select p.id, p.county_fips, p.parcel_no, p.owner_name, p.owner_mailing,
               p.property_address, p.acres, p.gis_acres, pi.source as import_source,
               pi.received_on, bnd.acres as field_acres,
               extensions.ST_Area(extensions.ST_Intersection(
                 ${overlayable('p.geom')}, ${overlayable('bnd.geom')})::extensions.geography)
                 / 4046.86 as overlap_acres
          from bnd
          join gis.parcels p on extensions.ST_Intersects(p.geom, bnd.geom)
          join gis.parcel_imports pi on pi.id = p.import_id) x
     where x.overlap_acres >= ${MIN_PARCEL_OVERLAP_ACRES}), '[]'::json),
  'notes', ${notesJson('fld')},
  'lineage', json_build_object(
    'parents', ${lineageJson('parent_field_id', 'child_field_id')},
    'children', ${lineageJson('child_field_id', 'parent_field_id')}),
  'openBoundaryRequests', (
    select count(*)::int
      from farm.boundary_change_requests r
     where r.field_id = $1::uuid and r.resolved_at is null),
  'spray', (
    select json_build_object(
             'fieldId', s.field_id, 'forHour', ${iso('s.for_hour')}, 'verdict', s.verdict,
             'reasons', s.reasons, 'rulesVersion', s.rules_version,
             'forecastIssuedAt', ${iso('s.forecast_issued_at')},
             'assessedAt', ${iso('s.assessed_at')})
      from farm.spray_assessments s
     where s.field_id = $1::uuid and s.for_hour = date_trunc('hour', $2::timestamptz, 'UTC')
     order by s.assessed_at desc, s.id desc
     limit 1)
) as detail
from fld`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `id` shaped like a uuid (so a bad URL gets 404, not a database cast error)? */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/** The SQL's JSON before the parts computed in TS (editability, the soils summary, open jobs). */
type RawFieldDetail = Omit<FieldDetail, 'boundary' | 'soilsSummary' | 'openJobs' | 'field'> & {
  field: FieldSummary;
  boundary: Omit<NonNullable<FieldDetail['boundary']>, 'editable' | 'readOnlyReason'> | null;
};

function parseJson<T>(v: unknown): T {
  // pg parses json columns; Drizzle's raw execute may hand back the text.
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

/** Assemble the contract type from the statement's JSON (pure; unit-tested). */
export function toFieldDetail(raw: RawFieldDetail): FieldDetail {
  const policy = boundaryEditPolicy(raw.field);
  return {
    ...raw,
    boundary: raw.boundary
      ? { ...raw.boundary, editable: policy.editable, readOnlyReason: policy.reason }
      : null,
    soilsSummary: raw.soils.length > 0 ? summarizeFieldSoils(raw.soils) : null,
    // Open jobs arrive with the job board (M2, 2a).
    openJobs: { count: 0, placeholder: true },
  };
}

/** The field's panel data, or null when there is no such field (any state, active or not). */
export async function fieldDetail(
  ex: Executor,
  fieldId: string,
  now: Date = new Date(),
): Promise<FieldDetail | null> {
  if (!isUuid(fieldId)) return null;
  const r = await exec<{ detail: unknown }>(ex, FIELD_DETAIL_SQL, [fieldId, now.toISOString()]);
  const row = r.rows[0];
  return row ? toFieldDetail(parseJson<RawFieldDetail>(row.detail)) : null;
}

export type SaveNotesResult =
  | { status: 'saved'; notes: FieldNotes }
  /** Someone saved since `version`: nothing was written; these are the notes as stored now. */
  | { status: 'conflict'; notes: FieldNotes }
  | { status: 'not_found' };

export interface SaveNotesInput {
  fieldId: string;
  /** Already normalized (src/ui/fields/notes.ts normalizeNotes); null clears the notes. */
  text: string | null;
  /** The FieldNotes.version the person edited. */
  version: string;
  /** Who saved (farm.app_users.id; null for a provisional session). */
  appUserId: string | null;
}

/**
 * Save the notes if nobody saved since `version`, and publish `fields`/`updated` (parts
 * ['notes']) in the same transaction. The caller has already checked the role
 * (ROLE_FOR.editFieldNotes). `updated_at` always moves forward, so every save is a new version.
 */
export async function saveFieldNotes(db: Db, input: SaveNotesInput): Promise<SaveNotesResult> {
  if (!isUuid(input.fieldId)) return { status: 'not_found' };
  return db.transaction(async (tx: DbTx) => {
    const saved = await exec<{ notes: unknown }>(
      tx,
      `with u as (
         update farm.fields f
            set notes = $2,
                notes_updated_at = now(),
                notes_updated_by = $3::uuid,
                updated_at = greatest(now(), f.updated_at + interval '1 microsecond')
          where f.id = $1::uuid and f.updated_at = $4::timestamptz
         returning f.notes, f.notes_updated_at, f.notes_updated_by, f.updated_at)
       select ${notesJson('u')} as notes from u`,
      [input.fieldId, input.text, input.appUserId, input.version],
    );
    const row = saved.rows[0];
    if (row) {
      await publish('fields', 'updated', { fieldId: input.fieldId, parts: ['notes'] }, tx);
      return { status: 'saved', notes: parseJson<FieldNotes>(row.notes) };
    }
    const current = await exec<{ notes: unknown }>(
      tx,
      `select ${notesJson('f')} as notes from farm.fields f where f.id = $1::uuid`,
      [input.fieldId],
    );
    const cur = current.rows[0];
    return cur
      ? { status: 'conflict', notes: parseJson<FieldNotes>(cur.notes) }
      : { status: 'not_found' };
  });
}
