/**
 * farm.operations (slice 1f, deere-ops; docs/contracts-1f.md §3.1, §5.1): the writer the
 * `deere.ops` sync step upserts through, the provisional → final sweep, and the field panel's
 * read (GET /api/fields/<id>/operations).
 *
 * Writer rules (one statement per operation, in the per-event transaction):
 *  - id = deterministicId('deere', <Deere operation id>), source 'deere', source_id = that id,
 *    source_org = the org it was read from, source_modified_at = Deere's modifiedTime;
 *  - field_id through the external ref ('deere', 'field', <field id>, <org>), else the one field
 *    whose deere_field_id is that id (an Ops Center import), else null (an unmapped field: a dq
 *    row, plan §7 "operations with no field");
 *  - machine_ids through the ('deere', 'machine', <machine id>, …) refs, the operation's org
 *    first, then any org (your machine doing custom work in a customer's org);
 *  - geom = the coverage, normalized like every boundary (NORMALIZED_POLYGON: overlapping parts
 *    unioned, made valid), then ST_SimplifyPreserveTopology at COVERAGE_TOLERANCE_DEG (≈ 1 m;
 *    a full-day sprayer log of ~43 000 polygons becomes a handful of rings);
 *  - area_clipped_ac = the geodesic area of coverage ∩ the field's boundary version valid at
 *    started_at (the current one when none was), so an operation is clipped by the boundary of
 *    its own season even after a split, merge or re-draw;
 *  - status (decision, deere-ops): `final` once the operation has ended and Deere hasn't changed
 *    it for FINAL_AFTER_MS (24 h, wall time) — `finalizeOperations` flips the ones that age into
 *    it — else `provisional`; a later change from Deere makes it provisional again;
 *  - a row that would not change is not touched (no updated_at churn, no realtime message).
 * The geometry steps run in MATERIALIZED CTEs: inlined, each use of the coverage would repeat
 * the union of a full-day sprayer log (~1 s each).
 */
import type { MultiPolygon } from 'geojson';
import type { NormalizedOperation } from '../../connectors/types';
import { deterministicId, isUuid } from '../../domain/ids';
import {
  type OperationKind,
  type OperationMeasurements,
  type OperationProduct,
  type OperationStatus,
  type OperationView,
  operationMeasurementsSchema,
  operationProductSchema,
} from '../../domain/operations';
import { type Executor, exec } from '../exec';
import { ACRES, NORMALIZED_POLYGON } from './boundaries-sql';

/** ST_SimplifyPreserveTopology tolerance of stored coverage, degrees (≈ 1.1 m N-S, 0.8 m E-W). */
export const COVERAGE_TOLERANCE_DEG = 0.00001;
/** An ended operation Deere hasn't changed for this long is final (decision, deere-ops). */
export const FINAL_AFTER_MS = 24 * 3_600_000;

/** `final` once ended and unchanged for FINAL_AFTER_MS before `now`, else `provisional`. */
export function operationStatus(
  op: Pick<NormalizedOperation, 'endedAt' | 'modifiedAt'>,
  now: Date,
): OperationStatus {
  if (!op.endedAt) return 'provisional';
  const changed = Date.parse(op.modifiedAt ?? op.endedAt);
  return changed <= now.getTime() - FINAL_AFTER_MS ? 'final' : 'provisional';
}

/** The farm.operations id of a synced operation. */
export const operationId = (source: string, externalId: string) =>
  deterministicId(source, externalId);

/** Stored source_modified_at (ISO) of synced operations, by vendor operation id. */
export async function storedOperationModified(
  ex: Executor,
  source: string,
  externalIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!externalIds.length) return out;
  const r = await exec<{ source_id: string; modified: Date | string | null }>(
    ex,
    `select source_id, source_modified_at as modified from farm.operations
      where source = $1 and source_id = any($2::text[])`,
    [source, [...new Set(externalIds)]],
  );
  for (const row of r.rows) {
    out.set(
      row.source_id,
      row.modified === null ? null : new Date(row.modified as string).toISOString(),
    );
  }
  return out;
}

/** The app field of a vendor field: its external ref, else the one field with that deere_field_id. */
async function fieldOf(
  ex: Executor,
  op: Pick<NormalizedOperation, 'source' | 'sourceOrg' | 'fieldExternalId'>,
): Promise<string | null> {
  if (!op.fieldExternalId) return null;
  const r = await exec<{ id: string | null }>(
    ex,
    `select coalesce(
        (select entity_id::text from ingest.external_refs
          where source = $1 and kind = 'field' and external_id = $2 and source_org = $3),
        (select min(id::text) from farm.fields where $1 = 'deere' and deere_field_id = $2
          having count(*) = 1)) as id`,
    [op.source, op.fieldExternalId, op.sourceOrg],
  );
  return r.rows[0]?.id ?? null;
}

/** farm.machines ids of vendor machine ids (the operation's org first, then any org). */
async function machinesOf(
  ex: Executor,
  op: Pick<NormalizedOperation, 'source' | 'sourceOrg' | 'machineExternalIds'>,
): Promise<string[]> {
  if (!op.machineExternalIds.length) return [];
  const r = await exec<{ external_id: string; entity_id: string }>(
    ex,
    `select distinct on (external_id) external_id, entity_id::text as entity_id
       from ingest.external_refs
      where source = $1 and kind = 'machine' and external_id = any($2::text[])
      order by external_id, (source_org = $3) desc, source_org`,
    [op.source, op.machineExternalIds, op.sourceOrg],
  );
  const byId = new Map(r.rows.map((x) => [x.external_id, x.entity_id]));
  return [
    ...new Set(op.machineExternalIds.map((m) => byId.get(m)).filter((m): m is string => !!m)),
  ].sort();
}

export interface UpsertOperationResult {
  id: string;
  fieldId: string | null;
  /** The row was inserted or changed (false: it was already exactly this). */
  changed: boolean;
  inserted: boolean;
}

/** Insert or update one synced operation (rules above). */
export async function upsertOperation(
  ex: Executor,
  op: NormalizedOperation,
  opts: { now: Date },
): Promise<UpsertOperationResult> {
  const id = operationId(op.source, op.externalId);
  const fieldId = await fieldOf(ex, op);
  const machineIds = await machinesOf(ex, op);
  const products = op.products.map((p) => operationProductSchema.parse(p));
  const measurements = operationMeasurementsSchema.parse(op.measurements);
  const coverage = op.coverage ? JSON.stringify(op.coverage satisfies MultiPolygon) : null;
  const r = await exec<{ id: string; field_id: string | null; inserted: boolean }>(
    ex,
    `with n as materialized (
       select case when $15::text is null then null else ${NORMALIZED_POLYGON('$15')} end as g
     ),
     cov as materialized (
       select case when n.g is null or extensions.ST_IsEmpty(n.g) then null
              else extensions.ST_Multi(extensions.ST_CollectionExtract(extensions.ST_MakeValid(
                     extensions.ST_SimplifyPreserveTopology(n.g, $16::float8)), 3)) end as g
         from n
     ),
     b as materialized (
       select coalesce(
         (select geom from farm.field_boundaries
           where field_id = $3::uuid and valid @> $6::timestamptz limit 1),
         (select geom from farm.field_boundaries
           where field_id = $3::uuid and upper_inf(valid) limit 1)) as g
     )
     insert into farm.operations as o (
       id, kind, field_id, crop_year, crop, started_at, ended_at, area_reported_ac,
       area_clipped_ac, products, measurements, machine_ids, operator_name, status, geom,
       source, source_id, source_org, source_modified_at)
     select $1::uuid, $2, $3::uuid, $4::int, $5, $6::timestamptz, $7::timestamptz,
            round($8::numeric, 4),
            case when cov.g is null or b.g is null then null
                 else round((${ACRES('extensions.ST_Intersection(cov.g, b.g)')})::numeric, 4) end,
            $9::jsonb, $10::jsonb, $11::uuid[], $12, $13, cov.g,
            $14, $17, $18, $19::timestamptz
       from cov, b
     on conflict (source, source_id) do update set
       kind = excluded.kind,
       field_id = excluded.field_id,
       crop_year = excluded.crop_year,
       crop = excluded.crop,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       area_reported_ac = excluded.area_reported_ac,
       area_clipped_ac = excluded.area_clipped_ac,
       products = excluded.products,
       measurements = excluded.measurements,
       machine_ids = excluded.machine_ids,
       operator_name = excluded.operator_name,
       status = excluded.status,
       geom = excluded.geom,
       source_org = excluded.source_org,
       source_modified_at = excluded.source_modified_at,
       updated_at = now()
     where (o.kind, o.field_id, o.crop_year, o.crop, o.started_at, o.ended_at,
            o.area_reported_ac, o.area_clipped_ac, o.products, o.measurements, o.machine_ids,
            o.operator_name, o.status, o.source_org, o.source_modified_at)
           is distinct from
           (excluded.kind, excluded.field_id, excluded.crop_year, excluded.crop,
            excluded.started_at, excluded.ended_at, excluded.area_reported_ac,
            excluded.area_clipped_ac, excluded.products, excluded.measurements,
            excluded.machine_ids, excluded.operator_name, excluded.status, excluded.source_org,
            excluded.source_modified_at)
        or o.geom is distinct from excluded.geom
     returning o.id::text as id, o.field_id::text as field_id, (o.xmax = 0) as inserted`,
    [
      id,
      op.kind,
      fieldId,
      op.cropYear,
      op.crop,
      op.startedAt,
      op.endedAt,
      op.areaAc,
      JSON.stringify(products),
      JSON.stringify(measurements),
      machineIds,
      op.operatorName,
      operationStatus(op, opts.now),
      op.source,
      coverage,
      COVERAGE_TOLERANCE_DEG,
      op.externalId,
      op.sourceOrg,
      op.modifiedAt,
    ],
  );
  const row = r.rows[0];
  return row
    ? { id, fieldId: row.field_id, changed: true, inserted: row.inserted }
    : { id, fieldId, changed: false, inserted: false };
}

/**
 * Flip synced operations that aged into `final` (ended, unchanged by the vendor for
 * FINAL_AFTER_MS before `now`). Returns the fields whose operations changed.
 */
export async function finalizeOperations(
  ex: Executor,
  source: string,
  now: Date,
): Promise<string[]> {
  const r = await exec<{ field_id: string | null }>(
    ex,
    `update farm.operations
        set status = 'final', updated_at = now()
      where source = $1 and status = 'provisional' and ended_at is not null
        and coalesce(source_modified_at, ended_at) <= $2::timestamptz
      returning field_id::text as field_id`,
    [source, new Date(now.getTime() - FINAL_AFTER_MS).toISOString()],
  );
  return [...new Set(r.rows.map((x) => x.field_id).filter((f): f is string => !!f))];
}

interface OperationRow {
  id: string;
  kind: OperationKind;
  crop_year: number;
  crop: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  area_reported_ac: number | null;
  area_clipped_ac: number | null;
  products: unknown;
  measurements: unknown;
  operator_name: string | null;
  status: OperationStatus;
  source: string;
  has_coverage: boolean;
  machines: { id: string; unitNo: string }[];
}

const isoOf = (v: Date | string) => new Date(v as string).toISOString();
const ac1 = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);

/** Stored jsonb read back leniently: a product or measurement that doesn't parse is left out. */
function productsOf(v: unknown): OperationProduct[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    const r = operationProductSchema.safeParse(p);
    return r.success ? [r.data] : [];
  });
}

function measurementsOf(v: unknown): OperationMeasurements {
  const r = operationMeasurementsSchema.safeParse(v);
  return r.success ? r.data : {};
}

/**
 * The operations of one field in one crop year, oldest first (OperationView). Null when the
 * field doesn't exist (or the id isn't a uuid).
 */
export async function fieldOperations(
  ex: Executor,
  fieldId: string,
  cropYear: number,
): Promise<OperationView[] | null> {
  if (!isUuid(fieldId)) return null;
  const r = await exec<OperationRow & { field_exists: boolean }>(
    ex,
    `select f.id is not null as field_exists, o.id::text as id, o.kind, o.crop_year, o.crop,
            o.started_at, o.ended_at, o.area_reported_ac::float8 as area_reported_ac,
            o.area_clipped_ac::float8 as area_clipped_ac, o.products, o.measurements,
            o.operator_name, o.status, o.source, o.geom is not null as has_coverage,
            coalesce((select json_agg(json_build_object('id', m.id::text, 'unitNo', m.unit_no)
                                      order by m.unit_no)
                        from farm.machines m where m.id = any(o.machine_ids)), '[]'::json)
              as machines
       from (select $1::uuid as id) q
       left join farm.fields f on f.id = q.id
       left join farm.operations o on o.field_id = f.id and o.crop_year = $2::int
      order by o.started_at nulls first, o.id`,
    [fieldId, cropYear],
  );
  if (!r.rows[0]?.field_exists) return null;
  return r.rows
    .filter((row) => row.id !== null)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      cropYear: row.crop_year,
      crop: row.crop,
      startedAt: isoOf(row.started_at),
      endedAt: row.ended_at === null ? null : isoOf(row.ended_at),
      areaReportedAc: ac1(row.area_reported_ac),
      areaClippedAc: ac1(row.area_clipped_ac),
      products: productsOf(row.products),
      measurements: measurementsOf(row.measurements),
      machines: row.machines,
      operatorName: row.operator_name,
      status: row.status,
      source: row.source,
      hasCoverage: row.has_coverage,
    }));
}

/**
 * Merge `fieldsPerRun` (fields the last run checked) into the stream's sync_state.extra
 * (src/connectors/deere/call-shares.ts: calls per field = callsPerRun / fieldsPerRun). Writers
 * merge their own keys and never replace the object (docs/contracts-1f.md §3.1).
 */
export async function recordFieldsPerRun(
  ex: Executor,
  source: string,
  stream: string,
  fieldsPerRun: number,
): Promise<void> {
  await exec(
    ex,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('fieldsPerRun', $3::int),
            updated_at = now()
      where source = $1 and stream = $2`,
    [source, stream, Math.max(0, Math.round(fieldsPerRun))],
  );
}
