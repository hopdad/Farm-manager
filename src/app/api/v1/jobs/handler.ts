/**
 * The job board's routes (slice 2a, jobs-api; docs/contracts-2a.md §5; schemas in
 * src/ui/work/contract.ts). Framework-free, so the DB tests call them under runWithSession;
 * the thin route.ts files next to them only await the params.
 *
 * Every route, in this order (src/app/api/machines/handler.ts): requireRole FIRST (401/403
 * `{ error, status, required }`); for writes a cross-site request is 403 `{ error: 'cross-site
 * request refused' }`, a body that isn't application/json 415, over JOB_BODY_MAX_BYTES 413,
 * not JSON 400, not the schema 400 `{ error }`; a path id that isn't a uuid 404; then the
 * query, a database failure being a logged 503. Every answer is JSON through limitedJson with
 * `cache-control: no-store`.
 *
 *   GET    /api/v1/jobs[?fieldId=]                    viewer     200 BoardSnapshot
 *   POST   /api/v1/jobs                               planJobs   201 JobResponse | 404 | 422
 *   GET    /api/v1/jobs/<id>                          viewer     200 JobResponse | 404
 *   PATCH  /api/v1/jobs/<id>                          planJobs   200 | 409 | 404 | 422
 *   PUT    /api/v1/jobs/<id>/field                    planJobs   200 | 409 | 404 | 422 not_on_field
 *   POST   /api/v1/jobs/<id>/assignments              planJobs   200 | 409 | 404 | 422 machine_retired
 *   DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=]  planJobs  200 | 409 | 404
 *   POST   /api/v1/jobs/<id>/status                   updateOwnJobStatus (own job below planJobs)
 *                                                                200 | 409 | 403 | 422 same / not_allowed
 *   POST   /api/v1/jobs/<id>/cancel                   planJobs   200 | 409 | 422 closed
 *   POST   /api/v1/jobs/reorder                       planJobs   200 BoardSnapshot | 409 | 422 not_in_lane
 *
 * A 409 is `{ error: JOB_CONFLICT_MESSAGE, job }` with the job as it is now (decision 2a-7) and
 * changes nothing. No route publishes realtime (the triggers do, decision 2a-8). Each write
 * answered 2xx records one `job_action` usage event with the route's pattern, after its
 * transaction committed, never failing the answer (decision 2a-11). Writes follow the lock
 * order of contracts-2a §4.7 (src/db/queries/work-jobs.ts).
 */
import type pg from 'pg';
import type { z } from 'zod';
import type { Executor } from '@/db/exec';
import {
  assignJob,
  cancelJob,
  createJob,
  type JobWriteResult,
  reorderJobs,
  setJobField,
  setJobStatus,
  unassignJob,
  updateJob,
} from '@/db/queries/work-jobs';
import { boardSnapshot, jobView } from '@/db/queries/work-jobs-view';
import { isUuid } from '@/domain/ids';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR, type Role, roleAtLeast, type Session } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { isSameOriginRequest } from '@/platform/http/origin';
import { recordUsage, usageOf } from '@/platform/usage/record';
import {
  ASSIGNMENT_PARTS,
  type AssignmentPart,
  assignJobBodySchema,
  type BoardSnapshot,
  cancelJobBodySchema,
  createJobBodySchema,
  JOB_BODY_MAX_BYTES,
  JOB_CONFLICT_MESSAGE,
  type JobConflictResponse,
  type JobResponse,
  reorderJobsBodySchema,
  setJobFieldBodySchema,
  setJobStatusBodySchema,
  updateJobBodySchema,
} from '@/ui/work/contract';

/** Each write's route pattern: the usage event's `route` and the log tag. */
export const JOB_ROUTES = {
  jobs: '/api/v1/jobs',
  job: '/api/v1/jobs/[id]',
  field: '/api/v1/jobs/[id]/field',
  assignments: '/api/v1/jobs/[id]/assignments',
  assignment: '/api/v1/jobs/[id]/assignments/[assignmentId]',
  status: '/api/v1/jobs/[id]/status',
  cancel: '/api/v1/jobs/[id]/cancel',
  reorder: '/api/v1/jobs/reorder',
} as const;
type JobRoute = (typeof JOB_ROUTES)[keyof typeof JOB_ROUTES];

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(status: number, body: unknown, route: string): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route: route.replace(/^\//, '') });
}

/** requireRole, or the 401/403 answer. */
async function sessionFor(min: Role): Promise<Session | Response> {
  try {
    return await requireRole(min);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
}

/** The first schema issue, with where it is ("window.to: …"). */
function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'bad request body';
  const where = issue.path.map(String).join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/** Same origin, JSON, at most JOB_BODY_MAX_BYTES, parsed by `schema`; or the refusal. */
async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  route: string,
): Promise<{ ok: true; body: z.output<S> } | { ok: false; res: Response }> {
  if (!isSameOriginRequest(request)) {
    return { ok: false, res: json(403, { error: 'cross-site request refused' }, route) };
  }
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return { ok: false, res: json(415, { error: 'send the job as application/json' }, route) };
  }
  const text = await readLimitedText(request, JOB_BODY_MAX_BYTES);
  if (text === null)
    return { ok: false, res: json(413, { error: 'request body too large' }, route) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, res: json(400, { error: 'body is not valid JSON' }, route) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, res: json(400, { error: issueText(parsed.error) }, route) };
  return { ok: true, body: parsed.data };
}

/** One job_action after the commit; a usage failure never fails the write (decision 2a-11). */
async function recordJobAction(session: Session, route: JobRoute): Promise<void> {
  try {
    await recordUsage(usageOf(session, 'job_action', route));
  } catch (e) {
    console.error(`[${route}] usage not recorded:`, (e as Error).message);
  }
}

function failed(route: string, e: unknown, what = 'the job could not be saved; try again') {
  console.error(`[${route}]`, (e as Error).message);
  return json(503, { error: what }, route);
}

/** The answer to a write: the job as it is now, a 409 with it, or the refusal. */
async function answerWrite(
  r: JobWriteResult,
  ex: Executor,
  session: Session,
  route: JobRoute,
  okStatus = 200,
): Promise<Response> {
  switch (r.status) {
    case 'saved': {
      await recordJobAction(session, route);
      const job = await jobView(ex, r.jobId);
      if (!job) return json(404, { error: 'job not found' }, route);
      const body: JobResponse = { job };
      return json(okStatus, body, route);
    }
    case 'conflict':
      return conflict(ex, r.jobId, route);
    case 'not_found':
      return json(404, { error: r.error }, route);
    case 'refused':
      return json(
        r.httpStatus,
        r.reason ? { error: r.error, reason: r.reason } : { error: r.error },
        route,
      );
    case 'invalid':
      return json(400, { error: r.error }, route);
  }
}

/** 409 `{ error, job }` with the job as it is now (404 when it is gone). */
async function conflict(ex: Executor, jobId: string, route: string): Promise<Response> {
  const job = await jobView(ex, jobId);
  if (!job) return json(404, { error: 'job not found' }, route);
  const body: JobConflictResponse = { error: JOB_CONFLICT_MESSAGE, job };
  return json(409, body, route);
}

const viewerOf = (s: Session): BoardSnapshot['viewer'] => ({
  role: s.role,
  partyId: s.partyId,
  canPlan: roleAtLeast(s.role, ROLE_FOR.planJobs),
});

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** GET /api/v1/jobs[?fieldId=]: the board snapshot (the Jobs tab: one field's jobs). */
export async function handleBoardSnapshot(
  request: Request,
  ex: Executor,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.jobs;
  const session = await sessionFor(ROLE_FOR.viewPrivate);
  if (session instanceof Response) return session;
  const fieldId = new URL(request.url).searchParams.get('fieldId');
  if (fieldId !== null && !isUuid(fieldId)) {
    return json(400, { error: 'fieldId must be a field id (a uuid)' }, route);
  }
  try {
    const body = await boardSnapshot(ex, { fieldId, now, viewer: viewerOf(session) });
    return json(200, body, route);
  } catch (e) {
    return failed(route, e, 'the job board is unavailable');
  }
}

/** GET /api/v1/jobs/<id>. */
export async function handleGetJob(jobId: string, ex: Executor): Promise<Response> {
  const route = JOB_ROUTES.job;
  const session = await sessionFor(ROLE_FOR.viewPrivate);
  if (session instanceof Response) return session;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const job = await jobView(ex, jobId);
    if (!job) return json(404, { error: 'job not found' }, route);
    const body: JobResponse = { job };
    return json(200, body, route);
  } catch (e) {
    return failed(route, e, 'the job is unavailable');
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/jobs. */
export async function handleCreateJob(
  request: Request,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.jobs;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, createJobBodySchema, route);
  if (!read.ok) return read.res;
  try {
    const r = await createJob(pool, read.body, session, now);
    return await answerWrite(r, pool, session, route, 201);
  } catch (e) {
    return failed(route, e);
  }
}

/** PATCH /api/v1/jobs/<id>. */
export async function handleUpdateJob(
  request: Request,
  jobId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.job;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, updateJobBodySchema, route);
  if (!read.ok) return read.res;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const r = await updateJob(pool, jobId, read.body, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

/** PUT /api/v1/jobs/<id>/field. */
export async function handleSetJobField(
  request: Request,
  jobId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.field;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, setJobFieldBodySchema, route);
  if (!read.ok) return read.res;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const r = await setJobField(pool, jobId, read.body, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

/** POST /api/v1/jobs/<id>/assignments. */
export async function handleAssignJob(
  request: Request,
  jobId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.assignments;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, assignJobBodySchema, route);
  if (!read.ok) return read.res;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const r = await assignJob(pool, jobId, read.body, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

const VERSION_RE = /^[1-9]\d{0,9}$/;

/** DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=machine|person]. */
export async function handleUnassignJob(
  request: Request,
  jobId: string,
  assignmentId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.assignment;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  if (!isSameOriginRequest(request)) {
    return json(403, { error: 'cross-site request refused' }, route);
  }
  const q = new URL(request.url).searchParams;
  const v = q.get('version') ?? '';
  const version = VERSION_RE.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    return json(400, { error: 'version must be the job version you saw (?version=N)' }, route);
  }
  const p = q.get('part');
  if (p !== null && !(ASSIGNMENT_PARTS as readonly string[]).includes(p)) {
    return json(400, { error: 'part must be machine or person' }, route);
  }
  const part = (p ?? undefined) as AssignmentPart | undefined;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  if (!isUuid(assignmentId)) return json(404, { error: 'assignment not found' }, route);
  try {
    const r = await unassignJob(pool, jobId, assignmentId, { version, part }, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

/** POST /api/v1/jobs/<id>/status (drivers and operators: their own job only). */
export async function handleSetJobStatus(
  request: Request,
  jobId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.status;
  const session = await sessionFor(ROLE_FOR.updateOwnJobStatus);
  if (session instanceof Response) return session;
  const read = await readBody(request, setJobStatusBodySchema, route);
  if (!read.ok) return read.res;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const r = await setJobStatus(pool, jobId, read.body, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

/** POST /api/v1/jobs/<id>/cancel. */
export async function handleCancelJob(
  request: Request,
  jobId: string,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.cancel;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, cancelJobBodySchema, route);
  if (!read.ok) return read.res;
  if (!isUuid(jobId)) return json(404, { error: 'job not found' }, route);
  try {
    const r = await cancelJob(pool, jobId, read.body, session, now);
    return await answerWrite(r, pool, session, route);
  } catch (e) {
    return failed(route, e);
  }
}

/** POST /api/v1/jobs/reorder: answers the board snapshot. */
export async function handleReorderJobs(
  request: Request,
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<Response> {
  const route = JOB_ROUTES.reorder;
  const session = await sessionFor(ROLE_FOR.planJobs);
  if (session instanceof Response) return session;
  const read = await readBody(request, reorderJobsBodySchema, route);
  if (!read.ok) return read.res;
  try {
    const r = await reorderJobs(pool, read.body, session);
    switch (r.status) {
      case 'saved': {
        await recordJobAction(session, route);
        const body = await boardSnapshot(pool, { now, viewer: viewerOf(session) });
        return json(200, body, route);
      }
      case 'conflict':
        return await conflict(pool, r.jobId, route);
      case 'refused':
        return json(422, { error: r.error, reason: r.reason }, route);
      case 'invalid':
        return json(400, { error: r.error }, route);
    }
  } catch (e) {
    return failed(route, e, 'the order could not be saved; try again');
  }
}
