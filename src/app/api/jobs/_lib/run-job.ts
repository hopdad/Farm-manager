/**
 * POST /api/jobs/<name> (docs/contracts.md §5, plan §1 "Every scheduled job is an idempotent
 * HTTP call"), with its dependencies injected so tests can drive it without Next:
 *
 *   1. `Authorization: Bearer <JOBS_SECRET>` (constant-time) else 401; unknown name 404.
 *   2. app.settings 'clock.paused' -> 202 { skipped: 'paused' } (claims nothing).
 *   3. ensureStream + claimDue on the JOB lease row ('job', <name>) for
 *      jobLeaseSeconds(budgetMs); held -> 202 { skipped: 'busy' } (a run is still in flight).
 *   4. 202 { accepted: true, name }.
 *   5. In `schedule` (Next's after()): run(ctx) with deadline = start + budgetMs and a signal
 *      that aborts at the deadline; a throw is a failure; then releaseLease and ONE
 *      ingest.job_runs row (job, host, started_at, finished_at, ok, items, note, error).
 *
 * Busy is a 202, not a 409: pg_cron/pg_net and the clock treat any 2xx as delivered, and an
 * overlapping fire is normal (the next tick comes anyway), not an error to retry.
 *
 * Bookkeeping (settings, lease, job_runs) runs on `pool` (the app pool); the job's own work
 * gets the small jobs pool via ctx.db/ctx.pool, so a slow sync never blocks the 202.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../../../../db/client';
import { type Executor, exec } from '../../../../db/exec';
import {
  type ClaimedLease,
  claimDue,
  ensureStream,
  JOB_LEASE_MODE,
  JOB_LEASE_SOURCE,
  jobLeaseSeconds,
  releaseLease,
} from '../../../../db/leases';
import { type ValidJob, validateJobDef } from '../../../../jobs/schedule';
import type { JobContext, JobLogger, JobRegistry } from '../../../../jobs/types';
import { readClockPaused } from './clock-setting';
import { createJobLogger } from './logger';

export interface JobRouteDeps {
  registry: JobRegistry;
  /** JOBS_SECRET. */
  secret: string;
  /** Route bookkeeping: clock.paused, the job lease, ingest.job_runs. */
  pool: Executor;
  /** Handed to the job as ctx.pool / ctx.db (the jobs pool). */
  jobsPool: pg.Pool;
  jobsDb: Db;
  /** Run work after the response (Next's `after`). */
  schedule(task: () => Promise<void>): void;
  now?: () => Date;
  logger?: (name: string) => JobLogger;
}

/** What one run recorded (also the ingest.job_runs row). */
export interface JobRunRecord {
  job: string;
  host: 'app' | 'pc';
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  items: number | null;
  note: string | null;
  error: string | null;
  /** False when the lease had expired and been claimed by someone else before release. */
  released: boolean;
}

export type JobPostBody =
  | { accepted: true; name: string }
  | { skipped: 'paused' | 'busy'; name: string }
  | { error: string };

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_TEXT = 2_000;

function json(status: number, body: JobPostBody, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Constant-time check of `Authorization: Bearer <secret>` (hashing equalizes lengths). */
export function bearerMatches(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const given = createHash('sha256')
    .update(m?.[1] ?? '')
    .digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(given, expected) && m !== null;
}

/** Short, single-purpose text for job_runs.error / sync_state.last_error. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message || e.name : String(e);
  return msg.length > MAX_TEXT ? `${msg.slice(0, MAX_TEXT - 1)}…` : msg;
}

function clip(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

function toItems(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
  return Math.max(0, Math.min(v, 2_147_483_647));
}

/** Raised on ctx.signal when the job's budget runs out. */
export class JobDeadlineError extends Error {
  constructor(name: string, budgetMs: number) {
    super(`job ${name} ran past its ${budgetMs} ms budget`);
    this.name = 'JobDeadlineError';
  }
}

export async function handleJobPost(
  req: Request,
  name: string,
  deps: JobRouteDeps,
): Promise<Response> {
  if (!bearerMatches(req.headers.get('authorization'), deps.secret)) {
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }
  const def = Object.hasOwn(deps.registry, name) ? deps.registry[name] : undefined;
  if (!def) return json(404, { error: `unknown job '${name}'` });
  let job: ValidJob;
  try {
    job = validateJobDef(name, def);
  } catch (e) {
    return json(500, { error: errorText(e) });
  }

  let lease: ClaimedLease | null;
  try {
    if (await readClockPaused(deps.pool)) return json(202, { skipped: 'paused', name });
    await ensureStream(deps.pool, JOB_LEASE_SOURCE, name, JOB_LEASE_MODE);
    lease = await claimDue(deps.pool, JOB_LEASE_SOURCE, name, jobLeaseSeconds(job.budgetMs));
  } catch (e) {
    console.error(`[jobs] ${name}: database error before the claim: ${errorText(e)}`);
    return json(503, { error: 'database unavailable' }, { 'Retry-After': '5' });
  }
  if (!lease) return json(202, { skipped: 'busy', name });

  const claimed = lease;
  try {
    deps.schedule(async () => {
      await runClaimedJob(job, claimed, deps);
    });
  } catch (e) {
    await releaseLease(deps.pool, claimed, { ok: false, error: errorText(e) }).catch(() => {});
    return json(500, { error: 'could not schedule the job' });
  }
  return json(202, { accepted: true, name });
}

/** Step 5: run a job whose lease is held, release it and record one ingest.job_runs row. */
export async function runClaimedJob(
  job: ValidJob,
  lease: ClaimedLease,
  deps: Pick<JobRouteDeps, 'pool' | 'jobsPool' | 'jobsDb' | 'now' | 'logger'>,
): Promise<JobRunRecord> {
  const now = deps.now ?? (() => new Date());
  const log = (deps.logger ?? ((n: string) => createJobLogger(n)))(job.name);
  const startedAt = now();
  const deadline = new Date(startedAt.getTime() + job.budgetMs);
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new JobDeadlineError(job.name, job.budgetMs)),
    job.budgetMs,
  );

  const ctx: JobContext = {
    name: job.name,
    db: deps.jobsDb,
    pool: deps.jobsPool,
    log,
    signal: ac.signal,
    now,
    deadline,
  };
  let ok = false;
  let items: number | null = null;
  let note: string | null = null;
  let error: string | null = null;
  try {
    const result = await job.def.run(ctx);
    ok = true;
    items = toItems(result?.items);
    note = clip(result?.note);
  } catch (e) {
    error = errorText(e);
  } finally {
    clearTimeout(timer);
  }
  const finishedAt = now();

  let released = false;
  try {
    released = await releaseLease(deps.pool, lease, { ok, error });
    if (!released) log.warn('job lease expired before release (the run outlived its lease)');
  } catch (e) {
    log.error(`could not release the job lease: ${errorText(e)}`);
  }
  try {
    await exec(
      deps.pool,
      `insert into ingest.job_runs (job, host, started_at, finished_at, ok, items, note, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [job.name, job.host, startedAt, finishedAt, ok, items, note, error],
    );
  } catch (e) {
    log.error(`could not record the run in ingest.job_runs: ${errorText(e)}`);
  }
  const ms = finishedAt.getTime() - startedAt.getTime();
  if (ok) log.debug(`ok in ${ms} ms`, { items, ...(note ? { note } : {}) });
  else log.warn(`failed in ${ms} ms: ${error}`);
  return { job: job.name, host: job.host, startedAt, finishedAt, ok, items, note, error, released };
}
