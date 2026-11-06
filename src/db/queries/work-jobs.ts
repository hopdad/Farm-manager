/**
 * The job board's writes (slice 2a, jobs-api; docs/contracts-2a.md §4.3-§4.7, §5.2). The
 * routes (src/app/api/v1/jobs/handler.ts) check the session and the body first; these run the
 * write and answer a JobWriteResult the route maps to 200 / 201 / 400 / 403 / 404 / 409 / 422.
 *
 * Every single-job write is ONE short transaction (src/db/queries/work-jobs-tx.ts) shaped the
 * same way (§4.7):
 *
 *   1. read the job (version, status, field, assignments) and whatever the rules need (the
 *      field's boundary acres, its farm's client, its growing year; machines, people,
 *      products): plain SELECTs, no lock, no trigger;
 *   2. refuse early (unknown id 404, a version that isn't the job's 409, a rule 422/403);
 *   3. the CAS `update farm.jobs set version = version + 1, … where id = $1 and version = $2`,
 *      carrying every job-row change (field, status and status_changed_at, acres, customer,
 *      crop year, sort key): the FIRST write, so the job row is locked before the publish
 *      trigger takes the `jobs` topic row; 0 rows = someone wrote since step 1 (409);
 *   4. the child rows (assignments, products), whose triggers publish too.
 *
 * Because every write to a job or its child rows bumps the version, the step-1 read is still
 * the job's state when the CAS succeeds. A write that changes nothing (a machine already on
 * the job, the field it already has) writes nothing and keeps the version. Reorder locks every
 * job it lists and the lane's open jobs with `select … for update` in id order, then writes
 * them in one statement (§4.7 rule 2). A deadlock retries the whole transaction once; a second
 * one is answered as a conflict with the job as it is then. Nothing here publishes: the
 * triggers do (db/pending/jobs-api.sql), and recordUsage runs in the route, after the commit.
 *
 * Automatic moves (autoJobStatus, decision 2a-3) ride on the CAS of every write that changes
 * the field or the assignments; status_changed_at moves with any status change (the injected
 * `now`). Planned acres and crop year follow decisions 2a-5 and 2a-6 (§4.6).
 */
import type pg from 'pg';
import { cropSeasonsToSync, currentCropYear } from '../../domain/crops';
import {
  type AssignmentChange,
  type AssignmentPlan,
  type AssignmentRowLike,
  autoJobStatus,
  type BusinessLine,
  checkJobTransition,
  DEFAULT_BUSINESS_LINE,
  isOpenJobStatus,
  JOB_STATUS_LABELS,
  type JobStatus,
  planAssignment,
  planJobReorder,
  planUnassignment,
  type ReorderRow,
} from '../../domain/work-jobs';
import type { Role } from '../../platform/auth/types';
import type {
  AssignJobBody,
  AssignmentPart,
  CancelJobBody,
  CreateJobBody,
  JOB_RULE_REASONS,
  JobProductInput,
  JobRequestInput,
  JobWindow,
  LngLat,
  ReorderJobsBody,
  SetJobFieldBody,
  SetJobStatusBody,
  UpdateJobBody,
} from '../../ui/work/contract';
import { fieldGrowingYear } from './operations';
import { OPEN_STATUS_SQL } from './work-jobs-sql';
import { rollbackWith, runJobTransaction } from './work-jobs-tx';

export type JobRuleReason = (typeof JOB_RULE_REASONS)[number];

/** Who writes: the session's person (null for a device-only or provisional session). */
export interface JobWriter {
  appUserId: string | null;
}

export type JobWriteResult =
  /** Written (or, `changed: false`, nothing to write: same version). */
  | { status: 'saved'; jobId: string; changed: boolean }
  | { status: 'not_found'; error: string }
  /** Stale version (or a second deadlock): answer 409 with this job as it is now. */
  | { status: 'conflict'; jobId: string }
  | { status: 'refused'; httpStatus: 403 | 422; error: string; reason?: JobRuleReason }
  /** A body the schema let through but the rules can't use (400). */
  | { status: 'invalid'; error: string };

const notFound = (error: string): JobWriteResult => ({ status: 'not_found', error });
const rule = (error: string, reason?: JobRuleReason): JobWriteResult => ({
  status: 'refused',
  httpStatus: 422,
  error,
  ...(reason ? { reason } : {}),
});

// ---------------------------------------------------------------------------------------------
// Reads (step 1)
// ---------------------------------------------------------------------------------------------

interface JobState {
  id: string;
  version: number;
  status: JobStatus;
  businessLine: BusinessLine;
  priority: number;
  fieldId: string | null;
  customerPartyId: string | null;
  plannedAcresByHand: boolean;
  assignments: AssignmentRowLike[];
  productIds: string[];
}

async function readJob(c: pg.PoolClient, id: string): Promise<JobState | null> {
  const r = await c.query<{
    id: string;
    version: number;
    status: JobStatus;
    business_line: BusinessLine;
    priority: number;
    field_id: string | null;
    customer_party_id: string | null;
    planned_acres_by_hand: boolean;
    assignments: AssignmentRowLike[];
    product_ids: string[];
  }>(
    `select j.id::text as id, j.version, j.status, j.business_line, j.priority,
            j.field_id::text as field_id, j.customer_party_id::text as customer_party_id,
            j.planned_acres_by_hand,
            coalesce((select json_agg(json_build_object(
                               'id', a.id, 'machineId', a.machine_id, 'partyId', a.party_id)
                             order by a.created_at, a.id)
                        from farm.job_assignments a where a.job_id = j.id), '[]'::json)
              as assignments,
            array(select jp.product_id::text from farm.job_products jp where jp.job_id = j.id)
              as product_ids
       from farm.jobs j
      where j.id = $1::uuid`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    businessLine: row.business_line,
    priority: Number(row.priority),
    fieldId: row.field_id,
    customerPartyId: row.customer_party_id,
    plannedAcresByHand: row.planned_acres_by_hand,
    assignments: row.assignments,
    productIds: row.product_ids,
  };
}

interface FieldFacts {
  id: string;
  /** The field's farm's client party (custom work), else null (our own farm). */
  clientPartyId: string | null;
  /** The CURRENT boundary's acres (null: no current boundary). */
  boundaryAcres: number | null;
}

async function fieldFacts(c: pg.PoolClient, fieldId: string): Promise<FieldFacts | null> {
  const r = await c.query<{ id: string; client: string | null; acres: number | null }>(
    `select f.id::text as id, fa.client_party_id::text as client, cb.acres::float8 as acres
       from farm.fields f
       join farm.farms fa on fa.id = f.farm_id
       left join farm.current_boundaries cb on cb.field_id = f.id
      where f.id = $1::uuid`,
    [fieldId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, clientPartyId: row.client, boundaryAcres: row.acres } : null;
}

/**
 * The ACTIVE field whose CURRENT boundary contains the point (on its edge counts), the
 * smallest first when boundaries overlap; null: not on a field (contracts-2a §4.5).
 */
export async function fieldAtPoint(c: pg.PoolClient | pg.Pool, at: LngLat): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    `select b.field_id::text as id
       from farm.current_boundaries b
       join farm.fields f on f.id = b.field_id
      where f.active
        and extensions.ST_Intersects(
              b.geom, extensions.ST_SetSRID(extensions.ST_MakePoint($1::float8, $2::float8), 4326))
      order by b.acres, b.field_id
      limit 1`,
    [at.lng, at.lat],
  );
  return r.rows[0]?.id ?? null;
}

/** Decision 2a-6: the field's growing year (D23), else the calendar year. */
async function cropYearOf(c: pg.PoolClient, fieldId: string, now: Date): Promise<number> {
  return (await fieldGrowingYear(c, fieldId, cropSeasonsToSync(now))) ?? currentCropYear(now);
}

async function partyExists(c: pg.PoolClient, id: string, kind?: 'person'): Promise<boolean> {
  const r = await c.query(
    `select 1 from farm.parties where id = $1::uuid and ($2::text is null or kind = $2)`,
    [id, kind ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The products a body names: 400 for one named twice, 404 for an unknown one, 422 for a
 * retired one that isn't on the job already (a job keeps a product retired after it was put
 * on; a new one can't take it). Null when they are fine.
 */
async function checkProducts(
  c: pg.PoolClient,
  products: readonly JobProductInput[],
  alreadyOn: readonly string[],
): Promise<JobWriteResult | null> {
  const ids = products.map((p) => p.productId.toLowerCase());
  if (new Set(ids).size !== ids.length)
    return { status: 'invalid', error: 'list each product once' };
  if (!ids.length) return null;
  const r = await c.query<{ id: string; name: string; active: boolean }>(
    `select id::text as id, name, active from farm.products where id = any($1::uuid[])`,
    [ids],
  );
  const found = new Map(r.rows.map((p) => [p.id, p]));
  if (ids.some((id) => !found.has(id))) return notFound('product not found');
  const on = new Set(alreadyOn.map((id) => id.toLowerCase()));
  const retired = r.rows.find((p) => !p.active && !on.has(p.id));
  if (retired) return rule(`${retired.name} is retired: pick another product`);
  return null;
}

// ---------------------------------------------------------------------------------------------
// The CAS (step 3) and the child writes (step 4)
// ---------------------------------------------------------------------------------------------

/** SET items of the CAS: `$1` job id, `$2` version, `$3` writer are taken. */
class JobSet {
  private readonly items: string[] = [];
  readonly values: unknown[];
  constructor(jobId: string, version: number, who: JobWriter) {
    this.values = [jobId, version, who.appUserId];
  }
  param(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
  set(column: string, value: unknown, cast: string): this {
    this.items.push(`${column} = ${this.param(value)}::${cast}`);
    return this;
  }
  setSql(column: string, sql: string): this {
    this.items.push(`${column} = ${sql}`);
    return this;
  }
  window(w: JobWindow | null): this {
    const stored = storedWindow(w);
    const has = this.param(stored !== null);
    const from = this.param(stored?.from ?? null);
    const to = this.param(stored?.to ?? null);
    return this.setSql(
      'planned_window',
      `case when ${has}::boolean then tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)') end`,
    );
  }
  /** The end of `line`'s open jobs (its largest sort_key + 10, this job left out). */
  laneEnd(line: BusinessLine): this {
    return this.setSql(
      'sort_key',
      `(select coalesce(max(o.sort_key), 0) + 10 from farm.jobs o
         where o.business_line = ${this.param(line)}::text and o.status in ${OPEN_STATUS_SQL}
           and o.id <> $1::uuid)`,
    );
  }
  status(next: JobStatus, now: Date): this {
    return this.set('status', next, 'text').set(
      'status_changed_at',
      now.toISOString(),
      'timestamptz',
    );
  }
  get sql(): string {
    return this.items.map((i) => `, ${i}`).join('');
  }
}

/** A window with no bound on either side is no window (null). */
function storedWindow(w: JobWindow | null | undefined): JobWindow | null {
  return w && (w.from !== null || w.to !== null) ? w : null;
}

/** Step 3: the compare-and-set. False: the version moved since the read (409). */
async function cas(c: pg.PoolClient, set: JobSet): Promise<boolean> {
  const r = await c.query(
    `update farm.jobs
        set version = version + 1, updated_at = now(),
            updated_by = (select u.id from farm.app_users u where u.id = $3::uuid)${set.sql}
      where id = $1::uuid and version = $2
     returning id`,
    set.values,
  );
  return r.rowCount === 1;
}

async function applyAssignmentChanges(
  c: pg.PoolClient,
  jobId: string,
  changes: readonly AssignmentChange[],
  who: JobWriter,
): Promise<void> {
  for (const ch of changes) {
    if (ch.op === 'delete') {
      await c.query('delete from farm.job_assignments where id = $1::uuid and job_id = $2::uuid', [
        ch.id,
        jobId,
      ]);
    } else if (ch.op === 'update') {
      await c.query(
        `update farm.job_assignments set machine_id = $3::uuid, party_id = $4::uuid, role = $5
          where id = $1::uuid and job_id = $2::uuid`,
        [ch.id, jobId, ch.machineId, ch.partyId, ch.role],
      );
    } else {
      await c.query(
        `insert into farm.job_assignments (job_id, machine_id, party_id, role, assigned_by)
         values ($1::uuid, $2::uuid, $3::uuid, $4,
                 (select u.id from farm.app_users u where u.id = $5::uuid))`,
        [jobId, ch.machineId, ch.partyId, ch.role, who.appUserId],
      );
    }
  }
}

/**
 * Replace the job's products with `products` (in that order for new ones): rows no longer named
 * go, named ones are inserted or updated (an unchanged row is left alone).
 */
async function replaceProducts(
  c: pg.PoolClient,
  jobId: string,
  products: readonly JobProductInput[],
  current: readonly string[],
): Promise<void> {
  const ids = products.map((p) => p.productId.toLowerCase());
  if (current.some((id) => !ids.includes(id.toLowerCase()))) {
    await c.query(
      `delete from farm.job_products where job_id = $1::uuid and not (product_id = any($2::uuid[]))`,
      [jobId, ids],
    );
  }
  if (!products.length) return;
  await c.query(
    `insert into farm.job_products as t (job_id, product_id, rate, unit, supplied_by, created_at)
     select $1::uuid, p.product_id, p.rate, p.unit, p.supplied_by,
            now() + (p.ord - 1) * interval '1 microsecond'
       from unnest($2::uuid[], $3::numeric[], $4::text[], $5::text[])
            with ordinality as p(product_id, rate, unit, supplied_by, ord)
     on conflict (job_id, product_id) do update
        set rate = excluded.rate, unit = excluded.unit, supplied_by = excluded.supplied_by
      where (t.rate, t.unit, t.supplied_by)
            is distinct from (excluded.rate, excluded.unit, excluded.supplied_by)`,
    [
      jobId,
      ids,
      products.map((p) => p.rate ?? null),
      products.map((p) => p.unit ?? null),
      products.map((p) => p.suppliedBy),
    ],
  );
}

/**
 * Run a single-job write; a second deadlock is a conflict with the job as it is then (a new
 * job, `jobId` null, has none to show: the route answers 503).
 */
async function writeJob(
  pool: pg.Pool,
  jobId: string | null,
  body: (c: pg.PoolClient) => Promise<JobWriteResult>,
): Promise<JobWriteResult> {
  const out = await runJobTransaction(pool, body, {
    onDeadlock: (attempt) =>
      console.warn(
        `[work-jobs] deadlock on job ${jobId ?? '(new)'} (try ${attempt}); retrying once`,
      ),
  });
  if (out.ok) return out.value;
  if (jobId === null) throw new Error('job write deadlocked twice');
  return { status: 'conflict', jobId };
}

/** Step 2 for every single-job write: 404, or 409 when `version` isn't the job's. */
async function readForWrite(c: pg.PoolClient, jobId: string, version: number): Promise<JobState> {
  const cur = await readJob(c, jobId);
  if (!cur) return rollbackWith(notFound('job not found'));
  if (cur.version !== version) return rollbackWith({ status: 'conflict', jobId });
  return cur;
}

/** Step 3, ending the transaction with a 409 when the version moved meanwhile. */
async function casOrConflict(c: pg.PoolClient, set: JobSet, jobId: string): Promise<void> {
  if (!(await cas(c, set))) rollbackWith<JobWriteResult>({ status: 'conflict', jobId });
}

const saved = (jobId: string, changed = true): JobWriteResult => ({
  status: 'saved',
  jobId,
  changed,
});

/** The request columns (decision 2a-9): null clears them. */
function setRequest(set: JobSet, request: JobRequestInput | null): void {
  set
    .set('request_channel', request?.channel ?? null, 'text')
    .set('requested_by_party_id', request?.partyId ?? null, 'uuid')
    .set('requester_name', blankToNull(request?.name), 'text')
    .set('requester_phone', blankToNull(request?.phone), 'text');
}

const blankToNull = (s: string | null | undefined): string | null => (s ? s : null);

/**
 * The field rules of a write that moves the job to `field` (contracts-2a §4.5, §4.6): the
 * customer from the field's farm when the job has none (and the body sets none), planned acres
 * re-snapshotted from the current boundary unless typed by hand, the crop year from the field's
 * growing year unless the body names one.
 */
async function applyFieldRules(
  c: pg.PoolClient,
  set: JobSet,
  cur: { customerPartyId: string | null; plannedAcresByHand: boolean },
  field: FieldFacts | null,
  opts: { customerInBody: boolean; acresInBody: boolean; cropYearInBody: boolean; now: Date },
): Promise<void> {
  set.set('field_id', field?.id ?? null, 'uuid');
  if (!field) return;
  if (!opts.customerInBody && cur.customerPartyId === null && field.clientPartyId) {
    set.set('customer_party_id', field.clientPartyId, 'uuid');
  }
  if (!opts.acresInBody && !cur.plannedAcresByHand) {
    set.set('planned_acres', field.boundaryAcres, 'numeric');
  }
  if (!opts.cropYearInBody) set.set('crop_year', await cropYearOf(c, field.id, opts.now), 'int');
}

// ---------------------------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/v1/jobs. Defaults (createJobBodySchema): the lane DEFAULT_BUSINESS_LINE[kind],
 * status planned (requested when a request is given), priority 3; with a field, the customer
 * from the field's farm when none is given, planned acres from the current boundary unless a
 * number is given (typed by hand), the crop year from the field's growing year unless given.
 * The new job goes to the end of its lane (the lane's largest sort_key + 10).
 */
export async function createJob(
  pool: pg.Pool,
  body: CreateJobBody,
  who: JobWriter,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  const products = body.products ?? [];
  return writeJob(pool, null, async (c) => {
    const bad = await checkProducts(c, products, []);
    if (bad) return rollbackWith(bad);
    const field = body.fieldId ? await fieldFacts(c, body.fieldId) : null;
    if (body.fieldId && !field) return rollbackWith(notFound('field not found'));
    if (body.customerPartyId && !(await partyExists(c, body.customerPartyId))) {
      return rollbackWith(notFound('customer not found'));
    }
    if (body.request?.partyId && !(await partyExists(c, body.request.partyId))) {
      return rollbackWith(notFound('requester not found'));
    }
    const line = body.businessLine ?? DEFAULT_BUSINESS_LINE[body.kind];
    const status = body.status ?? (body.request ? 'requested' : 'planned');
    const byHand = typeof body.plannedAcres === 'number';
    const acres = byHand ? body.plannedAcres : (field?.boundaryAcres ?? null);
    const cropYear = body.cropYear ?? (field ? await cropYearOf(c, field.id, now) : null);
    const customer = body.customerPartyId ?? field?.clientPartyId ?? null;
    const win = storedWindow(body.window);
    const r = await c.query<{ id: string }>(
      `insert into farm.jobs (kind, business_line, status, status_changed_at, title,
                              customer_party_id, field_id, planned_window, crop_year,
                              planned_acres, planned_acres_by_hand, planned_qty, planned_unit,
                              priority, sort_key, notes, request_channel, requested_by_party_id,
                              requester_name, requester_phone, created_by, updated_by)
       values ($1, $2, $3, $4::timestamptz, $5, $6::uuid, $7::uuid,
               case when $8::boolean then tstzrange($9::timestamptz, $10::timestamptz, '[)') end,
               $11::int, $12::numeric, $13, $14::numeric, $15, $16::int,
               (select coalesce(max(o.sort_key), 0) + 10 from farm.jobs o
                 where o.business_line = $2 and o.status in ${OPEN_STATUS_SQL}),
               $17, $18, $19::uuid, $20, $21,
               (select u.id from farm.app_users u where u.id = $22::uuid),
               (select u.id from farm.app_users u where u.id = $22::uuid))
       returning id::text as id`,
      [
        body.kind,
        line,
        status,
        now.toISOString(),
        blankToNull(body.title),
        customer,
        field?.id ?? null,
        win !== null,
        win?.from ?? null,
        win?.to ?? null,
        cropYear,
        acres ?? null,
        byHand,
        body.plannedQty ?? null,
        body.plannedUnit ?? null,
        body.priority ?? 3,
        blankToNull(body.notes),
        body.request?.channel ?? null,
        body.request?.partyId ?? null,
        blankToNull(body.request?.name),
        blankToNull(body.request?.phone),
        who.appUserId,
      ],
    );
    const id = r.rows[0]?.id as string;
    await replaceProducts(c, id, products, []);
    return saved(id);
  });
}

/**
 * PATCH /api/v1/jobs/<id>: only the fields present change (updateJobBodySchema). `fieldId`
 * follows PUT …/field's rules; `plannedAcres: null` hands the acres back to the boundary;
 * `products` replaces the list. A new lane or a new priority puts the job at the end of its
 * lane's open jobs (so at the end of its priority). Only `version`: nothing to write.
 */
export async function updateJob(
  pool: pg.Pool,
  jobId: string,
  body: UpdateJobBody,
  who: JobWriter,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readForWrite(c, jobId, body.version);
    const has = (k: keyof UpdateJobBody) => body[k] !== undefined;
    const set = new JobSet(jobId, body.version, who);
    let fieldTouched = false;
    let field: FieldFacts | null = null;
    if (has('fieldId') && (body.fieldId?.toLowerCase() ?? null) !== cur.fieldId) {
      fieldTouched = true;
      if (body.fieldId) {
        field = await fieldFacts(c, body.fieldId);
        if (!field) return rollbackWith(notFound('field not found'));
      }
    }
    if (body.customerPartyId && !(await partyExists(c, body.customerPartyId))) {
      return rollbackWith(notFound('customer not found'));
    }
    if (body.request?.partyId && !(await partyExists(c, body.request.partyId))) {
      return rollbackWith(notFound('requester not found'));
    }
    if (body.products) {
      const bad = await checkProducts(c, body.products, cur.productIds);
      if (bad) return rollbackWith(bad);
    }

    if (has('kind')) set.set('kind', body.kind, 'text');
    if (has('title')) set.set('title', blankToNull(body.title), 'text');
    if (has('notes')) set.set('notes', blankToNull(body.notes), 'text');
    if (has('window')) set.window(body.window ?? null);
    if (has('plannedQty')) set.set('planned_qty', body.plannedQty, 'numeric');
    if (has('plannedUnit')) set.set('planned_unit', body.plannedUnit, 'text');
    if (has('cropYear')) set.set('crop_year', body.cropYear, 'int');
    if (has('customerPartyId')) set.set('customer_party_id', body.customerPartyId, 'uuid');
    if (has('request')) setRequest(set, body.request ?? null);
    const line = body.businessLine ?? cur.businessLine;
    const moved = line !== cur.businessLine || (body.priority ?? cur.priority) !== cur.priority;
    if (has('businessLine')) set.set('business_line', line, 'text');
    if (has('priority')) set.set('priority', body.priority, 'int');
    if (moved && isOpenJobStatus(cur.status)) set.laneEnd(line);
    if (fieldTouched) {
      await applyFieldRules(c, set, cur, field, {
        customerInBody: has('customerPartyId'),
        acresInBody: has('plannedAcres'),
        cropYearInBody: has('cropYear'),
        now,
      });
    }
    if (typeof body.plannedAcres === 'number') {
      set
        .set('planned_acres', body.plannedAcres, 'numeric')
        .set('planned_acres_by_hand', true, 'boolean');
    } else if (body.plannedAcres === null) {
      // Back to the boundary's acres (the new field's, else the job's own).
      const fid = fieldTouched ? (field?.id ?? null) : cur.fieldId;
      const facts = fieldTouched ? field : fid ? await fieldFacts(c, fid) : null;
      set
        .set('planned_acres', facts?.boundaryAcres ?? null, 'numeric')
        .set('planned_acres_by_hand', false, 'boolean');
    }
    if (fieldTouched) {
      const next = autoJobStatus(cur.status, {
        hasField: field !== null,
        assignmentCount: cur.assignments.length,
      });
      if (next !== cur.status) set.status(next, now);
    }
    const writesProducts = body.products !== undefined;
    if (set.sql === '' && !writesProducts) return rollbackWith(saved(jobId, false));
    await casOrConflict(c, set, jobId);
    if (body.products) await replaceProducts(c, jobId, body.products, cur.productIds);
    return saved(jobId);
  });
}

/**
 * PUT /api/v1/jobs/<id>/field (a card dropped on the map, decision 2a-4): by id (null clears
 * it) or by the drop point (the active field whose current boundary contains it, else 422
 * not_on_field). The field it already has: nothing to write.
 */
export async function setJobField(
  pool: pg.Pool,
  jobId: string,
  body: SetJobFieldBody,
  who: JobWriter,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readForWrite(c, jobId, body.version);
    let fieldId: string | null;
    if ('at' in body) {
      fieldId = await fieldAtPoint(c, body.at);
      if (!fieldId) return rollbackWith(rule('not on a field', 'not_on_field'));
    } else {
      fieldId = body.fieldId;
    }
    if (fieldId?.toLowerCase() === cur.fieldId?.toLowerCase() || (!fieldId && !cur.fieldId)) {
      return rollbackWith(saved(jobId, false));
    }
    const field = fieldId ? await fieldFacts(c, fieldId) : null;
    if (fieldId && !field) return rollbackWith(notFound('field not found'));
    const set = new JobSet(jobId, body.version, who);
    await applyFieldRules(c, set, cur, field, {
      customerInBody: false,
      acresInBody: false,
      cropYearInBody: false,
      now,
    });
    const next = autoJobStatus(cur.status, {
      hasField: field !== null,
      assignmentCount: cur.assignments.length,
    });
    if (next !== cur.status) set.status(next, now);
    await casOrConflict(c, set, jobId);
    return saved(jobId);
  });
}

/**
 * POST /api/v1/jobs/<id>/assignments (a card dropped on a machine or person chip): planAssignment
 * decides the rows; a down machine is taken (the card flags it), a retired one is 422
 * machine_retired; one already on the job changes nothing (same version).
 */
export async function assignJob(
  pool: pg.Pool,
  jobId: string,
  body: AssignJobBody,
  who: JobWriter,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readForWrite(c, jobId, body.version);
    if (body.machineId) {
      const m = await c.query<{ status: string; unit_no: string }>(
        'select status, unit_no from farm.machines where id = $1::uuid',
        [body.machineId],
      );
      const machine = m.rows[0];
      if (!machine) return rollbackWith(notFound('machine not found'));
      if (machine.status === 'retired') {
        return rollbackWith(rule(`${machine.unit_no} is retired`, 'machine_retired'));
      }
    }
    if (body.partyId && !(await partyExists(c, body.partyId, 'person'))) {
      return rollbackWith(notFound('person not found'));
    }
    const plan = planAssignment(cur.assignments, {
      machineId: body.machineId?.toLowerCase(),
      partyId: body.partyId?.toLowerCase(),
    });
    return applyPlan(c, cur, plan, who, now);
  });
}

/**
 * DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=]: the whole row, or one side of
 * it (a row left with neither is deleted); an assignment of another job is 404.
 */
export async function unassignJob(
  pool: pg.Pool,
  jobId: string,
  assignmentId: string,
  input: { version: number; part?: AssignmentPart },
  who: JobWriter,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readForWrite(c, jobId, input.version);
    const plan = planUnassignment(cur.assignments, assignmentId.toLowerCase(), input.part);
    if (!plan) return rollbackWith(notFound('assignment not found'));
    return applyPlan(c, cur, plan, who, now);
  });
}

/** The CAS (with the automatic move) and the assignment rows of a plan; none: a no-op. */
async function applyPlan(
  c: pg.PoolClient,
  cur: JobState,
  plan: AssignmentPlan,
  who: JobWriter,
  now: Date,
): Promise<JobWriteResult> {
  if (!plan.changes.length) return rollbackWith(saved(cur.id, false));
  const set = new JobSet(cur.id, cur.version, who);
  const next = autoJobStatus(cur.status, {
    hasField: cur.fieldId !== null,
    assignmentCount: plan.count,
  });
  if (next !== cur.status) set.status(next, now);
  await casOrConflict(c, set, cur.id);
  await applyAssignmentChanges(c, cur.id, plan.changes, who);
  return saved(cur.id);
}

/** Who asks for a status move (the route's session). */
export interface JobStatusActor extends JobWriter {
  role: Role;
  /** The session's crew party: "own job" = it is on one of the job's assignments. */
  partyId: string | null;
}

/**
 * POST /api/v1/jobs/<id>/status (decision 2a-3): `cancelled` is refused here (422 not_allowed:
 * use /cancel); then the version (409); then checkJobTransition with via 'person' ('same' and
 * 'not_allowed' 422, 'forbidden' 403). A session with no person has no own job.
 */
export async function setJobStatus(
  pool: pg.Pool,
  jobId: string,
  body: SetJobStatusBody,
  who: JobStatusActor,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readJob(c, jobId);
    if (!cur) return rollbackWith(notFound('job not found'));
    if (body.status === 'cancelled') {
      return rollbackWith(rule('use /cancel to cancel a job', 'not_allowed'));
    }
    if (cur.version !== body.version) return rollbackWith({ status: 'conflict', jobId });
    const party = who.partyId?.toLowerCase() ?? null;
    const ownJob = party !== null && cur.assignments.some((a) => a.partyId === party);
    const check = checkJobTransition(cur.status, body.status, {
      role: who.role,
      ownJob,
      via: 'person',
    });
    if (!check.ok) {
      return rollbackWith(
        check.reason === 'forbidden'
          ? { status: 'refused', httpStatus: 403, error: check.message }
          : rule(check.message, check.reason),
      );
    }
    const set = new JobSet(jobId, body.version, who).status(body.status, now);
    await casOrConflict(c, set, jobId);
    return saved(jobId);
  });
}

/**
 * POST /api/v1/jobs/<id>/cancel: any open status, with an optional reason; a done, invoiced or
 * cancelled job is 422 closed.
 */
export async function cancelJob(
  pool: pg.Pool,
  jobId: string,
  body: CancelJobBody,
  who: JobStatusActor,
  now: Date = new Date(),
): Promise<JobWriteResult> {
  return writeJob(pool, jobId, async (c) => {
    const cur = await readForWrite(c, jobId, body.version);
    if (!isOpenJobStatus(cur.status)) {
      return rollbackWith(rule(`the job is already ${JOB_STATUS_LABELS[cur.status]}`, 'closed'));
    }
    const check = checkJobTransition(cur.status, 'cancelled', {
      role: who.role,
      ownJob: false,
      via: 'person',
    });
    if (!check.ok) {
      return rollbackWith(
        check.reason === 'forbidden'
          ? { status: 'refused', httpStatus: 403, error: check.message }
          : rule(check.message, check.reason),
      );
    }
    const set = new JobSet(jobId, body.version, who)
      .status('cancelled', now)
      .set('cancelled_reason', blankToNull(body.reason), 'text');
    await casOrConflict(c, set, jobId);
    return saved(jobId);
  });
}

export type ReorderResult =
  | { status: 'saved'; changed: number }
  | { status: 'conflict'; jobId: string }
  | { status: 'refused'; httpStatus: 422; error: string; reason: 'not_in_lane' }
  | { status: 'invalid'; error: string };

/**
 * POST /api/v1/jobs/reorder (decision 2a-1; contracts-2a §4.7 rule 2): lock the listed jobs and
 * the lane's open jobs in id order (`select … for update`: no trigger fires), check them with
 * planJobReorder, then write the moved sort keys (and their versions) in ONE statement.
 */
export async function reorderJobs(
  pool: pg.Pool,
  body: ReorderJobsBody,
  who: JobWriter,
): Promise<ReorderResult> {
  const listed = body.jobs.map((j) => ({ id: j.id.toLowerCase(), version: j.version }));
  if (new Set(listed.map((l) => l.id)).size !== listed.length) {
    return { status: 'invalid', error: 'list each job once' };
  }
  const first = listed[0]?.id ?? '';
  const out = await runJobTransaction(
    pool,
    async (c): Promise<ReorderResult> => {
      const r = await c.query<{
        id: string;
        version: number;
        status: JobStatus;
        business_line: BusinessLine;
        priority: number;
        sort_key: number;
        created_at: Date;
      }>(
        `select id::text as id, version, status, business_line, priority, sort_key, created_at
           from farm.jobs
          where id = any($1::uuid[])
             or (business_line = $2 and status in ${OPEN_STATUS_SQL})
          order by id
            for update`,
        [listed.map((l) => l.id), body.businessLine],
      );
      const rows: ReorderRow[] = r.rows.map((x) => ({
        id: x.id,
        version: Number(x.version),
        status: x.status,
        businessLine: x.business_line,
        priority: Number(x.priority),
        sortKey: Number(x.sort_key),
        createdAt: new Date(x.created_at).getTime(),
      }));
      const plan = planJobReorder(body.businessLine, listed, rows);
      if (!plan.ok) {
        return plan.reason === 'not_in_lane'
          ? {
              status: 'refused',
              httpStatus: 422,
              error: 'a listed job is not open in that lane',
              reason: 'not_in_lane',
            }
          : { status: 'conflict', jobId: plan.jobId };
      }
      if (plan.changes.length) {
        await c.query(
          `update farm.jobs j
              set sort_key = v.sort_key, version = j.version + 1, updated_at = now(),
                  updated_by = (select u.id from farm.app_users u where u.id = $3::uuid)
             from unnest($1::uuid[], $2::float8[]) as v(id, sort_key)
            where j.id = v.id`,
          [plan.changes.map((ch) => ch.id), plan.changes.map((ch) => ch.sortKey), who.appUserId],
        );
      }
      return { status: 'saved', changed: plan.changes.length };
    },
    {
      onDeadlock: (attempt) =>
        console.warn(`[work-jobs] deadlock on a reorder (try ${attempt}); retrying once`),
    },
  );
  return out.ok ? out.value : { status: 'conflict', jobId: first };
}
