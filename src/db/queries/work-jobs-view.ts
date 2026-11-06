/**
 * The job board's read side (slice 2a, jobs-api; docs/contracts-2a.md §5.2, §5.3): JobView for
 * one job, a set of jobs or the board snapshot, each from ONE statement.
 *
 *  - The statement selects the jobs (by id, or the board's: every open job plus the jobs that
 *    went done on the current farm day, optionally one field's), then builds per job its field
 *    (with the CURRENT boundary's acres), customer, window, request, assignments (machine with
 *    its "Deere" badge, person, and `alsoOn`: the other OPEN jobs that share the machine or the
 *    person on an overlapping window, contracts-2a §4.5) and products, as JSON with the
 *    contract's keys. Times leave as UTC ISO.
 *  - TS adds what the domain decides: the summary (jobSummary), the person's initials and the
 *    flags (jobFlags: no field, a machine down, double-booked, acres differ, restricted use).
 *
 * Overlap (decision 2a-4): per assignment on coalesce(assignment.planned_for, job.planned_window)
 * with `&&`; a null window never overlaps; only open jobs (OPEN_JOB_STATUSES) count, on either
 * side. Flagged, never blocked.
 */
import { FARM_TIME_ZONE, farmDate } from '../../domain/farm';
import type { MachineKind, MachineStatus } from '../../domain/fleet';
import type { AssignmentRole } from '../../domain/work-jobs';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  type BusinessLine,
  type JobKind,
  type JobPlannedUnit,
  type JobPriority,
  type JobStatus,
  jobFlags,
  jobSummary,
  type ProductKind,
  personInitials,
  type RateUnit,
  type RequestChannel,
  type SuppliedBy,
} from '../../domain/work-jobs';
import type { BoardLane, BoardSnapshot, JobView } from '../../ui/work/contract';
import { type Executor, exec } from '../exec';
import { OPEN_STATUS_SQL } from './work-jobs-sql';

/** UTC ISO with milliseconds, or null. */
const iso = (expr: string) =>
  `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A tstzrange as `{ from, to }` (null bound = open), or null. */
const rangeJson = (expr: string) => `case when (${expr}) is null then null
  else json_build_object(
    'from', case when lower_inf(${expr}) then null else ${iso(`lower(${expr})`)} end,
    'to', case when upper_inf(${expr}) then null else ${iso(`upper(${expr})`)} end) end`;

const OTHER_ON_WINDOW = (side: 'machine_id' | 'party_id') => `
      select a.id as assignment_id, b.job_id as other_id
        from asg a
        join farm.job_assignments b on b.${side} = a.${side} and b.job_id <> a.job_id
        join farm.jobs o on o.id = b.job_id
       where a.${side} is not null
         and a.open and a.eff is not null
         and o.status in ${OPEN_STATUS_SQL}
         and coalesce(b.planned_for, o.planned_window) && a.eff`;

/**
 * The view statement over a selection: `selection` is a query returning `id` (a job id) and
 * `ord` (the answer's order), with its own $n parameters.
 */
export function jobViewSql(selection: string): string {
  return `
with sel as materialized (${selection}),
job as materialized (
  select j.*, sel.ord from farm.jobs j join sel on sel.id = j.id
),
asg as materialized (
  select a.id, a.job_id, a.role, a.machine_id, a.party_id, a.planned_for, a.created_at,
         coalesce(a.planned_for, j.planned_window) as eff,
         j.status in ${OPEN_STATUS_SQL} as open
    from farm.job_assignments a
    join job j on j.id = a.job_id
),
also as materialized (
  ${OTHER_ON_WINDOW('machine_id')}
  union
  ${OTHER_ON_WINDOW('party_id')}
)
select j.id::text as id, j.version, j.kind, j.business_line, j.status,
       ${iso('j.status_changed_at')} as status_changed_at, j.title,
       j.field_id::text as field_id, f.name as field_name, fa.name as farm_name,
       cb.acres::float8 as boundary_acres,
       j.customer_party_id::text as customer_id, cp.display_name as customer_name,
       ${rangeJson('j.planned_window')} as "window",
       j.crop_year, j.planned_acres::float8 as planned_acres, j.planned_acres_by_hand,
       j.planned_qty::float8 as planned_qty, j.planned_unit, j.priority, j.sort_key, j.notes,
       j.request_channel, j.requested_by_party_id::text as requested_by_party_id,
       j.requester_name, j.requester_phone, j.request_link_id is not null as via_link,
       j.cancelled_reason, j.deere_work_plan_id,
       ${iso('j.created_at')} as created_at, ${iso('j.updated_at')} as updated_at,
       coalesce((
         select json_agg(json_build_object(
                  'id', a.id,
                  'role', a.role,
                  'machine', case when m.id is null then null else json_build_object(
                    'id', m.id, 'unitNo', m.unit_no, 'kind', m.kind, 'status', m.status,
                    'workPlanCapable', (m.source = 'deere' or exists (
                      select 1 from ingest.external_refs r
                       where r.source = 'deere' and r.kind = 'machine' and r.entity_id = m.id)))
                    end,
                  'person', case when p.id is null then null else json_build_object(
                    'partyId', p.id, 'name', p.display_name) end,
                  'plannedFor', ${rangeJson('a.planned_for')},
                  'alsoOn', coalesce((
                    select json_agg(json_build_object(
                             'jobId', o.id, 'title', o.title, 'kind', o.kind,
                             'fieldName', of2.name, 'plannedAcres', o.planned_acres,
                             'plannedQty', o.planned_qty, 'plannedUnit', o.planned_unit)
                           order by lower(o.planned_window) nulls last, o.id)
                      from also x
                      join farm.jobs o on o.id = x.other_id
                      left join farm.fields of2 on of2.id = o.field_id
                     where x.assignment_id = a.id), '[]'::json))
                order by a.created_at, m.unit_no nulls last, p.display_name nulls last, a.id)
           from asg a
           left join farm.machines m on m.id = a.machine_id
           left join farm.parties p on p.id = a.party_id
          where a.job_id = j.id), '[]'::json) as assignments,
       coalesce((
         select json_agg(json_build_object(
                  'id', jp.id, 'productId', pr.id, 'name', pr.name, 'kind', pr.kind,
                  'rate', jp.rate, 'unit', jp.unit, 'suppliedBy', jp.supplied_by,
                  'restrictedUse', pr.restricted_use, 'epaRegNo', pr.epa_reg_no)
                order by jp.created_at, pr.name, jp.id)
           from farm.job_products jp
           join farm.products pr on pr.id = jp.product_id
          where jp.job_id = j.id), '[]'::json) as products
  from job j
  left join farm.fields f on f.id = j.field_id
  left join farm.farms fa on fa.id = f.farm_id
  left join farm.current_boundaries cb on cb.field_id = j.field_id
  left join farm.parties cp on cp.id = j.customer_party_id
 order by j.ord, j.id`;
}

/** The board's selection: open jobs plus those done on the farm day; $1 farm day, $2 field. */
export const BOARD_SELECTION_SQL = `
  select j.id,
         row_number() over (
           order by (j.status = 'done'),
                    case when j.status = 'done' then null else j.priority end,
                    case when j.status = 'done' then null else j.sort_key end,
                    case when j.status = 'done' then null else j.created_at end,
                    j.status_changed_at, j.id) as ord
    from farm.jobs j
   where (j.status in ${OPEN_STATUS_SQL}
          or (j.status = 'done'
              and j.status_changed_at >= ($1::date)::timestamp at time zone '${FARM_TIME_ZONE}'
              and j.status_changed_at < ($1::date + 1)::timestamp at time zone '${FARM_TIME_ZONE}'))
     and ($2::uuid is null or j.field_id = $2::uuid)`;

const BY_IDS_SELECTION_SQL = `
  select j.id, array_position($1::uuid[], j.id) as ord
    from farm.jobs j
   where j.id = any($1::uuid[])`;

interface RawOther {
  jobId: string;
  title: string | null;
  kind: JobKind;
  fieldName: string | null;
  plannedAcres: number | null;
  plannedQty: number | null;
  plannedUnit: JobPlannedUnit | null;
}

interface RawAssignment {
  id: string;
  role: AssignmentRole;
  machine: {
    id: string;
    unitNo: string;
    kind: MachineKind;
    status: MachineStatus;
    workPlanCapable: boolean;
  } | null;
  person: { partyId: string; name: string } | null;
  plannedFor: { from: string | null; to: string | null } | null;
  alsoOn: RawOther[];
}

interface RawProduct {
  id: string;
  productId: string;
  name: string;
  kind: ProductKind;
  rate: number | null;
  unit: RateUnit | null;
  suppliedBy: SuppliedBy;
  restrictedUse: boolean;
  epaRegNo: string | null;
}

/** One row of jobViewSql. */
export interface JobViewRow {
  id: string;
  version: number;
  kind: JobKind;
  business_line: BusinessLine;
  status: JobStatus;
  status_changed_at: string;
  title: string | null;
  field_id: string | null;
  field_name: string | null;
  farm_name: string | null;
  boundary_acres: number | null;
  customer_id: string | null;
  customer_name: string | null;
  window: { from: string | null; to: string | null } | null;
  crop_year: number | null;
  planned_acres: number | null;
  planned_acres_by_hand: boolean;
  planned_qty: number | null;
  planned_unit: JobPlannedUnit | null;
  priority: number;
  sort_key: number;
  notes: string | null;
  request_channel: RequestChannel | null;
  requested_by_party_id: string | null;
  requester_name: string | null;
  requester_phone: string | null;
  via_link: boolean;
  cancelled_reason: string | null;
  deere_work_plan_id: string | null;
  created_at: string;
  updated_at: string;
  assignments: unknown;
  products: unknown;
}

function parseJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
/** Acres as shown: two decimals (the flags compare the stored values). */
const round2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

/** Assemble the contract's JobView from one statement row (pure; unit-tested). */
export function toJobView(row: JobViewRow): JobView {
  const assignments = parseJson<RawAssignment[]>(row.assignments);
  const products = parseJson<RawProduct[]>(row.products);
  const plannedAcres = num(row.planned_acres);
  const boundaryAcres = row.field_id ? num(row.boundary_acres) : null;
  const plannedQty = num(row.planned_qty);
  return {
    id: row.id,
    version: Number(row.version),
    kind: row.kind,
    businessLine: row.business_line,
    status: row.status,
    statusChangedAt: row.status_changed_at,
    title: row.title,
    summary: jobSummary({
      kind: row.kind,
      title: row.title,
      fieldName: row.field_name,
      plannedAcres,
      plannedQty,
      plannedUnit: row.planned_unit,
    }),
    field: row.field_id
      ? {
          id: row.field_id,
          name: row.field_name ?? '',
          farmName: row.farm_name,
          boundaryAcres: round2(boundaryAcres),
        }
      : null,
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name ?? '' } : null,
    window: row.window,
    cropYear: row.crop_year,
    plannedAcres: round2(plannedAcres),
    plannedAcresByHand: row.planned_acres_by_hand,
    plannedQty,
    plannedUnit: row.planned_unit,
    priority: row.priority as JobPriority,
    sortKey: Number(row.sort_key),
    notes: row.notes,
    request: row.request_channel
      ? {
          channel: row.request_channel,
          partyId: row.requested_by_party_id,
          name: row.requester_name,
          phone: row.requester_phone,
          viaLink: row.via_link,
        }
      : null,
    cancelledReason: row.cancelled_reason,
    deereWorkPlanId: row.deere_work_plan_id,
    assignments: assignments.map((a) => ({
      id: a.id,
      role: a.role,
      machine: a.machine,
      person: a.person
        ? {
            partyId: a.person.partyId,
            name: a.person.name,
            initials: personInitials(a.person.name),
          }
        : null,
      plannedFor: a.plannedFor,
      alsoOn: a.alsoOn.map((o) => ({
        jobId: o.jobId,
        summary: jobSummary({
          kind: o.kind,
          title: o.title,
          fieldName: o.fieldName,
          plannedAcres: num(o.plannedAcres),
          plannedQty: num(o.plannedQty),
          plannedUnit: o.plannedUnit,
        }),
      })),
    })),
    products: products.map((p) => ({
      id: p.id,
      productId: p.productId,
      name: p.name,
      kind: p.kind,
      rate: num(p.rate),
      unit: p.unit,
      suppliedBy: p.suppliedBy,
      restrictedUse: p.restrictedUse,
      epaRegNo: p.epaRegNo,
    })),
    flags: jobFlags({
      hasField: row.field_id !== null,
      plannedAcres,
      boundaryAcres,
      machinesDown: assignments.filter((a) => a.machine?.status === 'down').length,
      overlaps: assignments.filter((a) => a.alsoOn.length > 0).length,
      restrictedUse: products.some((p) => p.restrictedUse),
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The views of these jobs, in the order given (unknown ids are left out). */
export async function jobViews(ex: Executor, ids: readonly string[]): Promise<JobView[]> {
  if (!ids.length) return [];
  const r = await exec<JobViewRow>(ex, jobViewSql(BY_IDS_SELECTION_SQL), [ids]);
  return r.rows.map(toJobView);
}

/** One job's view, or null when there is no such job. */
export async function jobView(ex: Executor, id: string): Promise<JobView | null> {
  return (await jobViews(ex, [id]))[0] ?? null;
}

/** Group views (already in board order) into the four lanes, in BUSINESS_LINES order. */
export function toLanes(jobs: readonly JobView[]): BoardLane[] {
  return BUSINESS_LINES.map((line) => ({
    businessLine: line,
    label: BUSINESS_LINE_LABELS[line],
    jobs: jobs.filter((j) => j.businessLine === line),
  }));
}

export interface BoardSnapshotOptions {
  /** Only this field's jobs (the field panel's Jobs tab). */
  fieldId?: string | null;
  now?: Date;
  viewer: BoardSnapshot['viewer'];
}

/**
 * GET /api/v1/jobs: every open job plus the jobs that went done on `now`'s farm day
 * (America/Detroit), in the four lanes; a lane lists its open jobs by priority, then sort_key,
 * then created_at (decision 2a-1), then the day's done jobs by status_changed_at.
 */
export async function boardSnapshot(
  ex: Executor,
  opts: BoardSnapshotOptions,
): Promise<BoardSnapshot> {
  const now = opts.now ?? new Date();
  const r = await exec<JobViewRow>(ex, jobViewSql(BOARD_SELECTION_SQL), [
    farmDate(now),
    opts.fieldId ?? null,
  ]);
  return {
    asOf: now.toISOString(),
    viewer: opts.viewer,
    lanes: toLanes(r.rows.map(toJobView)),
  };
}
