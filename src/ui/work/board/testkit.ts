/**
 * TEST KIT (not used by the app): an in-memory stand-in for the job board's API
 * (docs/contracts-2a.md §5; GET/PUT/POST/DELETE under /api/v1/jobs and GET /api/v1/crew) with
 * the semantics of §4.3-§4.7, so the board's e2e specs run with Playwright route mocks before
 * jobs-api's routes are merged (contracts-2a §11.2: "Before the merge it runs with route mocks
 * for the API and the e2e realtime double for the second screen; the integrator runs it
 * unmocked"), and the board's unit tests exercise the client against it.
 *
 *  - `MockJobsApi.handle(request)`: one request in, `{ status, body }` out, answered the way the
 *    contract says (401/403 by role and own job, 400 on a bad body, 404, the 409 with the
 *    current job, 422 with its reason, the version compare-and-set, the automatic moves, the
 *    assignment fill rules, reorder's full-lane rule, the snapshot's lane order and flags).
 *    POST /api/v1/jobs and PATCH (job-forms' form) answer 501 like the foundation's stubs.
 *  - `onChange(listener)`: after every write that changed something, the JobsUpdatedPayload the
 *    jobs triggers would publish (ids only; old and new field ids) — the specs hand it to the
 *    e2e realtime double (`window.__fleetEmit('jobs', …)`) of the other screen.
 *  - `createSqlWorld(query)`: the world the mock reads fields, machines and crew from, through
 *    a `pg`-style query function (the e2e database: real demo machines and crew, the spec's own
 *    fields, so the map's tiles and the fleet panel agree with the mock).
 *  - `mockRouteHandler(api, viewer)`: a Playwright `context.route` handler for it.
 *
 * Kept small and pure (no Playwright, no pg imports); ./testkit.test.ts checks it against the
 * contract's schemas.
 */
import { farmDate } from '../../../domain/farm';
import { deterministicId } from '../../../domain/ids';
import {
  autoJobStatus,
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  checkJobTransition,
  isOpenJobStatus,
  JOB_FLAGS,
  JOB_KIND_LABELS,
  type JobFlag,
} from '../../../domain/work-jobs';
import { ROLE_FOR, type Role, roleAtLeast } from '../../../platform/auth/types';
import type { JobsUpdatedPayload } from '../../../platform/realtime/types';
import {
  type AssignJobBody,
  assignJobBodySchema,
  type BoardSnapshot,
  type CancelJobBody,
  type CrewPerson,
  cancelJobBodySchema,
  JOB_CONFLICT_MESSAGE,
  type JobAssignmentView,
  type JobMachineView,
  type JobPersonView,
  type JobView,
  type JobWindow,
  type ReorderJobsBody,
  reorderJobsBodySchema,
  type SetJobFieldBody,
  type SetJobStatusBody,
  setJobFieldBodySchema,
  setJobStatusBodySchema,
} from '../contract';
import { acresDiffer, formatAcres, sortLaneJobs } from './model';

// ---------------------------------------------------------------------------------------------
// The world the mock reads (fields, machines, people)
// ---------------------------------------------------------------------------------------------

export interface MockField {
  id: string;
  name: string;
  farmName: string | null;
  boundaryAcres: number | null;
  /** The field's farm's client party (decision 2a-4: a job's customer default). */
  customer: { id: string; name: string } | null;
}

export interface MockWorld {
  field(id: string): Promise<MockField | null>;
  /** The field whose current boundary contains the point (the drop's lng/lat fallback). */
  fieldAt(lngLat: { lng: number; lat: number }): Promise<string | null>;
  machine(id: string): Promise<JobMachineView | null>;
  person(partyId: string): Promise<JobPersonView | null>;
  crew(): Promise<CrewPerson[]>;
}

/** A world from plain maps (unit tests). */
export function createMapWorld(input: {
  fields?: MockField[];
  machines?: JobMachineView[];
  crew?: CrewPerson[];
  fieldAt?: (lngLat: { lng: number; lat: number }) => string | null;
}): MockWorld {
  const fields = new Map((input.fields ?? []).map((f) => [f.id, f]));
  const machines = new Map((input.machines ?? []).map((m) => [m.id, m]));
  const crew = input.crew ?? [];
  return {
    field: async (id) => fields.get(id) ?? null,
    fieldAt: async (ll) => input.fieldAt?.(ll) ?? null,
    machine: async (id) => machines.get(id) ?? null,
    person: async (partyId) => {
      const p = crew.find((c) => c.partyId === partyId);
      return p ? { partyId: p.partyId, name: p.name, initials: p.initials } : null;
    },
    crew: async () => crew,
  };
}

/** What `createSqlWorld` needs: pg's `Pool.query` shape. */
export type SqlQuery = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const initials = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return `${w[0]?.[0] ?? ''}${w.length > 1 ? (w.at(-1)?.[0] ?? '') : ''}`.toUpperCase();
};

/** The e2e database as the mock's world (read-only queries, as farm_app). */
export function createSqlWorld(query: SqlQuery): MockWorld {
  return {
    async field(id) {
      const r = await query(
        `select f.id::text as id, f.name, fa.name as farm_name, b.acres::float8 as acres,
                cp.id::text as customer_id, cp.display_name as customer_name
           from farm.fields f
           join farm.farms fa on fa.id = f.farm_id
           left join farm.current_boundaries b on b.field_id = f.id
           left join farm.parties cp on cp.id = fa.client_party_id
          where f.id = $1::uuid`,
        [id],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        name: String(row.name),
        farmName: row.farm_name === null ? null : String(row.farm_name),
        boundaryAcres: row.acres === null ? null : Number(row.acres),
        customer:
          row.customer_id === null
            ? null
            : { id: String(row.customer_id), name: String(row.customer_name) },
      };
    },
    async fieldAt({ lng, lat }) {
      const r = await query(
        `select f.id::text as id
           from farm.fields f
           join farm.current_boundaries b on b.field_id = f.id
          where f.active
            and extensions.ST_Contains(b.geom, extensions.ST_SetSRID(extensions.ST_Point($1, $2), 4326))
          limit 1`,
        [lng, lat],
      );
      return r.rows[0] ? String(r.rows[0].id) : null;
    },
    async machine(id) {
      const r = await query(
        `select m.id::text as id, m.unit_no, m.kind, m.status,
                (m.source = 'deere' or exists (
                   select 1 from ingest.external_refs x
                    where x.source = 'deere' and x.kind = 'machine' and x.entity_id = m.id
                )) as wpc
           from farm.machines m where m.id = $1::uuid`,
        [id],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        unitNo: String(row.unit_no),
        kind: row.kind as JobMachineView['kind'],
        status: row.status as JobMachineView['status'],
        workPlanCapable: row.wpc === true,
      };
    },
    async person(partyId) {
      const r = await query(
        `select p.id::text as id, p.display_name from farm.parties p
          where p.id = $1::uuid and p.kind = 'person' and 'crew' = any(p.roles)`,
        [partyId],
      );
      const row = r.rows[0];
      if (!row) return null;
      const name = String(row.display_name);
      return { partyId: String(row.id), name, initials: initials(name) };
    },
    async crew() {
      const r = await query(
        `select p.id::text as id, p.display_name, u.id::text as app_user_id, u.role,
                coalesce(u.active, false) as active
           from farm.parties p
           left join farm.app_users u on u.party_id = p.id
          where p.kind = 'person' and 'crew' = any(p.roles)
          order by p.display_name, p.id`,
      );
      return r.rows.map((row) => {
        const name = String(row.display_name);
        return {
          partyId: String(row.id),
          appUserId: row.app_user_id === null ? null : String(row.app_user_id),
          name,
          initials: initials(name),
          appRole: (row.role ?? null) as CrewPerson['appRole'],
          active: row.app_user_id === null ? true : row.active === true,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export interface MockViewer {
  role: Role;
  /** The session's person (null: a device with no one signed in). */
  partyId: string | null;
}

export interface MockRequest {
  method: string;
  url: string;
  body: string | null;
  /** Null: signed out (401). */
  viewer: MockViewer | null;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

/** A JobView with sensible defaults (tests and specs seed jobs with it). */
export function makeJobView(
  partial: Partial<JobView> & Pick<JobView, 'id' | 'kind'>,
  now: Date = new Date(),
): JobView {
  const at = now.toISOString();
  const job: JobView = {
    version: 1,
    businessLine: partial.businessLine ?? 'spraying',
    status: 'planned',
    statusChangedAt: at,
    title: null,
    summary: '',
    field: null,
    customer: null,
    window: null,
    cropYear: null,
    plannedAcres: null,
    plannedAcresByHand: false,
    plannedQty: null,
    plannedUnit: null,
    priority: 3,
    sortKey: 10,
    notes: null,
    request: null,
    cancelledReason: null,
    deereWorkPlanId: null,
    assignments: [],
    products: [],
    flags: [],
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
  return { ...job, summary: partial.summary || summaryOf(job) };
}

/** jobSummary's rule (contracts-2a §4.3): the title, else "Spray · Field · 78 ac". */
export function summaryOf(job: JobView): string {
  if (job.title) return job.title;
  const acres = formatAcres(job.plannedAcres);
  const qty =
    job.plannedQty !== null
      ? `${job.plannedQty}${job.plannedUnit ? ` ${job.plannedUnit}` : ''}`
      : null;
  return [JOB_KIND_LABELS[job.kind], job.field?.name, acres ?? qty].filter(Boolean).join(' · ');
}

type Range = { from: number; to: number };

function rangeOf(w: JobWindow | null): Range | null {
  if (!w || (w.from === null && w.to === null)) return null;
  return {
    from: w.from === null ? Number.NEGATIVE_INFINITY : Date.parse(w.from),
    to: w.to === null ? Number.POSITIVE_INFINITY : Date.parse(w.to),
  };
}

const overlaps = (a: Range | null, b: Range | null) => !!a && !!b && a.from < b.to && b.from < a.to;

const isUuidLike = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const authError = (status: 401 | 403, required: Role) => ({
  status,
  body: { error: status === 401 ? 'sign in first' : 'not allowed for your role', status, required },
});

const json = (status: number, body: unknown): MockResponse => ({ status, body });

export class MockJobsApi {
  readonly jobs = new Map<string, JobView>();
  /** Every request handled (method, path and query, parsed body), oldest first. */
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  private readonly listeners = new Set<(p: JobsUpdatedPayload) => void>();
  private seq = 0;

  constructor(
    private readonly world: MockWorld,
    private readonly opts: { now?: () => Date } = {},
  ) {}

  now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Put a job on the board (as seeded: its flags and summary are computed). */
  put(job: JobView): JobView {
    this.jobs.set(job.id, job);
    this.refresh();
    return this.jobs.get(job.id) as JobView;
  }

  /** Someone else changed the job (its version goes up): the next write from a screen is a 409. */
  touch(jobId: string, patch: Partial<JobView> = {}): JobView {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    const next: JobView = {
      ...job,
      ...patch,
      version: job.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.jobs.set(jobId, { ...next, summary: patch.summary ?? summaryOf(next) });
    this.refresh();
    return this.jobs.get(jobId) as JobView;
  }

  onChange(listener: (payload: JobsUpdatedPayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The request log of one method and path prefix (assertions in the specs). */
  calls(method: string, pathPrefix: string): { path: string; body: unknown }[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  /** The board snapshot for a viewer (GET /api/v1/jobs). */
  snapshot(viewer: MockViewer, fieldId?: string): BoardSnapshot {
    const today = farmDate(this.now());
    const all = [...this.jobs.values()].filter(
      (j) =>
        (isOpenJobStatus(j.status) ||
          (j.status === 'done' && farmDate(j.statusChangedAt) === today)) &&
        (!fieldId || j.field?.id === fieldId),
    );
    return {
      asOf: this.now().toISOString(),
      viewer: {
        role: viewer.role,
        partyId: viewer.partyId,
        canPlan: roleAtLeast(viewer.role, ROLE_FOR.planJobs),
      },
      lanes: BUSINESS_LINES.map((line) => ({
        businessLine: line,
        label: BUSINESS_LINE_LABELS[line],
        jobs: sortLaneJobs(all.filter((j) => j.businessLine === line)),
      })),
    };
  }

  async handle(req: MockRequest): Promise<MockResponse> {
    const url = new URL(req.url, 'http://mock.invalid');
    const path = url.pathname;
    let parsed: unknown = null;
    if (req.body) {
      try {
        parsed = JSON.parse(req.body);
      } catch {
        this.requests.push({ method: req.method, path: path + url.search, body: req.body });
        return json(400, { error: 'the body is not JSON' });
      }
    }
    this.requests.push({ method: req.method, path: path + url.search, body: parsed });
    if (!req.viewer) return authError(401, 'viewer');
    const viewer = req.viewer;
    const m = req.method.toUpperCase();

    if (path === '/api/v1/crew' && m === 'GET')
      return json(200, { people: await this.world.crew() });
    if (path === '/api/v1/jobs' && m === 'GET') {
      return json(200, this.snapshot(viewer, url.searchParams.get('fieldId') ?? undefined));
    }
    if (path === '/api/v1/jobs/reorder' && m === 'POST') return this.reorder(viewer, parsed);

    const parts = path.split('/').filter(Boolean); // api v1 jobs <id> [sub] [aid]
    if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'jobs' || !parts[3]) {
      return json(501, { error: 'not built yet' });
    }
    const id = decodeURIComponent(parts[3]);
    const sub = parts[4] ?? null;
    if (!sub && m === 'GET') {
      const job = this.jobs.get(id);
      return job ? json(200, { job }) : json(404, { error: 'no such job' });
    }
    if (!sub) return json(501, { error: 'not built yet' });

    const isStatus = sub === 'status' && m === 'POST';
    const need = isStatus ? ROLE_FOR.updateOwnJobStatus : ROLE_FOR.planJobs;
    if (!roleAtLeast(viewer.role, need)) return authError(403, need);
    if (!isUuidLike(id)) return json(404, { error: 'no such job' });
    const job = this.jobs.get(id);

    if (sub === 'field' && m === 'PUT') {
      const body = setJobFieldBodySchema.safeParse(parsed);
      if (!body.success) return json(400, { error: 'bad body' });
      if (!job) return json(404, { error: 'no such job' });
      return this.setField(job, body.data);
    }
    if (sub === 'assignments' && m === 'POST' && !parts[5]) {
      const body = assignJobBodySchema.safeParse(parsed);
      if (!body.success) return json(400, { error: 'bad body' });
      if (!job) return json(404, { error: 'no such job' });
      return this.assign(job, body.data);
    }
    if (sub === 'assignments' && m === 'DELETE' && parts[5]) {
      const version = Number(url.searchParams.get('version'));
      const part = url.searchParams.get('part');
      if (!Number.isInteger(version) || version < 1) return json(400, { error: 'version' });
      if (part !== null && part !== 'machine' && part !== 'person') {
        return json(400, { error: 'part' });
      }
      if (!job) return json(404, { error: 'no such job' });
      return this.unassign(job, decodeURIComponent(parts[5]), version, part);
    }
    if (isStatus) {
      const body = setJobStatusBodySchema.safeParse(parsed);
      if (!body.success) return json(400, { error: 'bad body' });
      if (!job) return json(404, { error: 'no such job' });
      return this.setStatus(job, body.data, viewer);
    }
    if (sub === 'cancel' && m === 'POST') {
      const body = cancelJobBodySchema.safeParse(parsed);
      if (!body.success) return json(400, { error: 'bad body' });
      if (!job) return json(404, { error: 'no such job' });
      return this.cancel(job, body.data);
    }
    return json(501, { error: 'not built yet' });
  }

  // -------------------------------------------------------------------------------------------

  private conflict(job: JobView): MockResponse {
    return json(409, { error: JOB_CONFLICT_MESSAGE, job: this.jobs.get(job.id) });
  }

  /** The write's compare-and-set + bookkeeping: version + 1, the automatic move, flags, publish. */
  private commit(before: JobView, after: JobView): MockResponse {
    const status = autoJobStatus(after.status, {
      hasField: after.field !== null,
      assignmentCount: after.assignments.length,
    });
    const now = this.now().toISOString();
    const next: JobView = {
      ...after,
      status,
      statusChangedAt: status !== before.status ? now : after.statusChangedAt,
      version: before.version + 1,
      updatedAt: now,
    };
    this.jobs.set(next.id, { ...next, summary: summaryOf(next) });
    this.refresh();
    this.publish([before, this.jobs.get(next.id) as JobView]);
    return json(200, { job: this.jobs.get(next.id) });
  }

  private publish(versions: JobView[]): void {
    const uniq = (xs: (string | null | undefined)[]) => [
      ...new Set(xs.filter((x): x is string => !!x)),
    ];
    const payload: JobsUpdatedPayload = {
      jobIds: uniq(versions.map((j) => j.id)),
      fieldIds: uniq(versions.map((j) => j.field?.id)),
      machineIds: uniq(versions.flatMap((j) => j.assignments.map((a) => a.machine?.id))),
      partyIds: uniq(versions.flatMap((j) => j.assignments.map((a) => a.person?.partyId))),
    };
    this.seq += 1;
    for (const l of this.listeners) l(payload);
  }

  /** Flags and "also on" are the server's, computed on read (§4.5): recompute them all. */
  private refresh(): void {
    const all = [...this.jobs.values()];
    const open = all.filter((j) => isOpenJobStatus(j.status));
    for (const job of all) {
      const jobRange = rangeOf(job.window);
      let doubled = 0;
      const assignments: JobAssignmentView[] = job.assignments.map((a) => {
        const mine = rangeOf(a.plannedFor) ?? jobRange;
        const alsoOn = isOpenJobStatus(job.status)
          ? open
              .filter((o) => o.id !== job.id)
              .filter((o) =>
                o.assignments.some((b) => {
                  const same =
                    (a.machine && b.machine?.id === a.machine.id) ||
                    (a.person && b.person?.partyId === a.person.partyId);
                  return same && overlaps(mine, rangeOf(b.plannedFor) ?? rangeOf(o.window));
                }),
              )
              .map((o) => ({ jobId: o.id, summary: o.summary || summaryOf(o) }))
          : [];
        if (alsoOn.length) doubled += 1;
        return { ...a, alsoOn };
      });
      const flags = new Set<JobFlag>();
      if (!job.field) flags.add('no_field');
      if (assignments.some((a) => a.machine?.status === 'down')) flags.add('machine_down');
      if (doubled > 0) flags.add('double_booked');
      if (acresDiffer(job.plannedAcres, job.field?.boundaryAcres ?? null))
        flags.add('acres_differ');
      if (job.products.some((p) => p.restrictedUse)) flags.add('restricted_use');
      this.jobs.set(job.id, {
        ...job,
        assignments,
        flags: JOB_FLAGS.filter((f) => flags.has(f)),
        summary: job.summary || summaryOf(job),
      });
    }
  }

  private async setField(job: JobView, body: SetJobFieldBody): Promise<MockResponse> {
    if (body.version !== job.version) return this.conflict(job);
    let fieldId: string | null;
    if ('at' in body) {
      fieldId = await this.world.fieldAt(body.at);
      if (!fieldId) return json(422, { error: 'not on a field', reason: 'not_on_field' });
    } else {
      fieldId = body.fieldId;
    }
    if (fieldId === null) return this.commit(job, { ...job, field: null });
    const field = await this.world.field(fieldId);
    if (!field) return json(404, { error: 'no such field' });
    return this.commit(job, {
      ...job,
      field: {
        id: field.id,
        name: field.name,
        farmName: field.farmName,
        boundaryAcres: field.boundaryAcres,
      },
      customer: job.customer ?? field.customer,
      plannedAcres: job.plannedAcresByHand ? job.plannedAcres : field.boundaryAcres,
      cropYear: job.cropYear ?? Number(farmDate(this.now()).slice(0, 4)),
    });
  }

  private nextAssignmentId(job: JobView): string {
    let n = job.assignments.length + 1;
    const taken = new Set(job.assignments.map((a) => a.id));
    let id = deterministicId('mock', `${job.id}:assignment:${n}:${job.version}`);
    while (taken.has(id)) {
      n += 1;
      id = deterministicId('mock', `${job.id}:assignment:${n}:${job.version}`);
    }
    return id;
  }

  private async assign(job: JobView, body: AssignJobBody): Promise<MockResponse> {
    if (body.version !== job.version) return this.conflict(job);
    let assignments = job.assignments;
    if (body.machineId) {
      const machine = await this.world.machine(body.machineId);
      if (!machine) return json(404, { error: 'no such machine' });
      if (machine.status === 'retired') {
        return json(422, { error: 'that machine is retired', reason: 'machine_retired' });
      }
      if (!assignments.some((a) => a.machine?.id === machine.id)) {
        const row = assignments.find((a) => a.person && !a.machine);
        assignments = row
          ? assignments.map((a) => (a === row ? { ...a, machine, role: 'operator' } : a))
          : [
              ...assignments,
              {
                id: this.nextAssignmentId(job),
                role: 'crew',
                machine,
                person: null,
                plannedFor: null,
                alsoOn: [],
              },
            ];
      }
    }
    if (body.partyId) {
      const person = await this.world.person(body.partyId);
      if (!person) return json(404, { error: 'no such person' });
      if (!assignments.some((a) => a.person?.partyId === person.partyId)) {
        const row = assignments.find((a) => a.machine && !a.person);
        assignments = row
          ? assignments.map((a) => (a === row ? { ...a, person, role: 'operator' } : a))
          : [
              ...assignments,
              {
                id: this.nextAssignmentId({ ...job, assignments }),
                role: 'crew',
                machine: null,
                person,
                plannedFor: null,
                alsoOn: [],
              },
            ];
      }
    }
    // Already on the job: nothing changes (200, same version).
    if (assignments === job.assignments) return json(200, { job });
    return this.commit(job, { ...job, assignments });
  }

  private unassign(
    job: JobView,
    assignmentId: string,
    version: number,
    part: 'machine' | 'person' | null,
  ): MockResponse {
    if (version !== job.version) return this.conflict(job);
    const row = job.assignments.find((a) => a.id === assignmentId);
    if (!row) return json(404, { error: 'no such assignment' });
    const assignments = job.assignments.flatMap((a) => {
      if (a !== row) return [a];
      if (part === null) return [];
      const left = part === 'machine' ? { ...a, machine: null } : { ...a, person: null };
      if (!left.machine && !left.person) return [];
      return [
        { ...left, role: left.machine && left.person ? 'operator' : 'crew' } as JobAssignmentView,
      ];
    });
    return this.commit(job, { ...job, assignments });
  }

  private setStatus(job: JobView, body: SetJobStatusBody, viewer: MockViewer): MockResponse {
    if (body.version !== job.version) return this.conflict(job);
    if (body.status === 'cancelled') {
      return json(422, { error: 'use /cancel to cancel a job', reason: 'not_allowed' });
    }
    const ownJob =
      viewer.partyId !== null && job.assignments.some((a) => a.person?.partyId === viewer.partyId);
    const check = checkJobTransition(job.status, body.status, { role: viewer.role, ownJob });
    if (!check.ok) {
      return check.reason === 'forbidden'
        ? json(403, { error: check.message })
        : json(422, { error: check.message, reason: check.reason });
    }
    return this.commit(job, {
      ...job,
      status: body.status,
      statusChangedAt: this.now().toISOString(),
    });
  }

  private cancel(job: JobView, body: CancelJobBody): MockResponse {
    if (!isOpenJobStatus(job.status)) {
      return json(422, { error: 'the job is closed', reason: 'closed' });
    }
    if (body.version !== job.version) return this.conflict(job);
    return this.commit(job, {
      ...job,
      status: 'cancelled',
      statusChangedAt: this.now().toISOString(),
      cancelledReason: body.reason ?? null,
    });
  }

  private reorder(viewer: MockViewer, parsed: unknown): MockResponse {
    if (!roleAtLeast(viewer.role, ROLE_FOR.planJobs)) return authError(403, ROLE_FOR.planJobs);
    const body = reorderJobsBodySchema.safeParse(parsed);
    if (!body.success) return json(400, { error: 'bad body' });
    const b: ReorderJobsBody = body.data;
    const laneOpen = [...this.jobs.values()].filter(
      (j) => j.businessLine === b.businessLine && isOpenJobStatus(j.status),
    );
    for (const item of b.jobs) {
      const job = this.jobs.get(item.id);
      if (!job || !laneOpen.includes(job)) {
        return json(422, { error: 'that job is not open in this lane', reason: 'not_in_lane' });
      }
      if (job.version !== item.version) return this.conflict(job);
    }
    const missing = laneOpen.find((j) => !b.jobs.some((x) => x.id === j.id));
    if (missing) return this.conflict(missing);
    const changed: JobView[] = [];
    b.jobs.forEach((item, i) => {
      const job = this.jobs.get(item.id) as JobView;
      const sortKey = (i + 1) * 10;
      if (job.sortKey !== sortKey) {
        const next = {
          ...job,
          sortKey,
          version: job.version + 1,
          updatedAt: this.now().toISOString(),
        };
        this.jobs.set(job.id, next);
        changed.push(next);
      }
    });
    if (changed.length) {
      this.refresh();
      this.publish(changed);
    }
    return json(200, this.snapshot(viewer));
  }
}

// ---------------------------------------------------------------------------------------------
// Playwright glue (structural types: this file imports no Playwright)
// ---------------------------------------------------------------------------------------------

/** The part of Playwright's Route the handler uses. */
export interface RouteLike {
  request(): { method(): string; url(): string; postData(): string | null };
  fulfill(response: {
    status: number;
    contentType: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
}

/** The URLs the mock answers (the board's: jobs and crew). */
export function isMockedJobsUrl(url: URL): boolean {
  return url.pathname === '/api/v1/crew' || /^\/api\/v1\/jobs(\/|$)/.test(url.pathname);
}

/** A `context.route(isMockedJobsUrl, handler)` handler answering from `api` as `viewer`. */
export function mockRouteHandler(
  api: MockJobsApi,
  viewer: MockViewer | null,
): (route: RouteLike) => Promise<void> {
  return async (route) => {
    const req = route.request();
    const res = await api.handle({
      method: req.method(),
      url: req.url(),
      body: req.postData(),
      viewer,
    });
    await route.fulfill({
      status: res.status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(res.body),
    });
  };
}

/** A `fetch` answered by the mock (unit tests drive the board's client against it). */
export function mockFetch(api: MockJobsApi, viewer: MockViewer | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await api.handle({
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? init.body : null,
      viewer,
    });
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
