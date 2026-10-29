/**
 * Scheduled-job contract (plan §1). One registry (src/jobs/registry.ts) feeds the local clock
 * (tools/clock), the shop-PC worker and the Supabase Cron SQL (`pnpm jobs:emit-cron`).
 *
 * Every job is an idempotent HTTP call. POST /api/jobs/<name> (runtime agent) does, in order:
 *   1. `Authorization: Bearer <JOBS_SECRET>` (constant-time compare) else 401; unknown name 404.
 *   2. app.settings 'clock.paused' = true -> 202 { skipped: 'paused' } (claims nothing).
 *   3. Claim the JOB lease on the row (source 'job', stream <name>) with src/db/leases.ts:
 *        await ensureStream(pool, JOB_LEASE_SOURCE, name, JOB_LEASE_MODE);
 *        const lease = await claimDue(pool, JOB_LEASE_SOURCE, name, jobLeaseSeconds(budgetMs));
 *      null -> 202 { skipped: 'busy' } (a run of this job is still in flight).
 *   4. 202 { accepted: true, name }.
 *   5. In Next's `after()`: build the JobContext (deadline = start + budgetMs; `signal` aborts at
 *      the deadline), `await def.run(ctx)`, catch any throw as a failure, then
 *      `releaseLease(pool, lease, { ok, error })` and insert ONE ingest.job_runs row
 *      (job, host, started_at, finished_at, ok, items, note, error).
 * The route never touches a connector's (source, stream) row. Inside run(), runSyncStep claims
 * the STREAM lease (src/connectors/types.ts); when that is held elsewhere the job returns
 * `{ items: 0, note: 'lease held elsewhere' }`. Two levels, two rows, so they never collide.
 *
 * Schedules are UTC. `every` accepts only '1-59 seconds' (pg_cron's only interval form);
 * anything a minute or longer is a 5-field cron string. src/jobs/schedule.ts validates both;
 * the clock and jobs:emit-cron must call `validateRegistry` before using a registry.
 *
 * Rules for job code (lint-enforced where possible): no child_process (also not transitively,
 * e.g. via src/lib/proc.ts or src/db/admin.ts), nothing from tools/** or scripts/**, nothing
 * GDAL-backed; never read process.env (use getConfig()).
 *
 * Owned by the foundation stage; changes go through the stage report.
 */
import type pg from 'pg';
import type { Db } from '../db/client';

/** pg_cron interval form: '1 seconds' … '59 seconds' (validated at runtime). */
export type EverySpec = `${number} seconds`;

/** Where a job runs: 'app' = the Next app (Vercel in production); 'pc' = the shop PC worker. */
export type JobHost = 'app' | 'pc';

/** Default and maximum work budget (Vercel maxDuration on /api/jobs/* is 60 s). */
export const DEFAULT_JOB_BUDGET_MS = 45_000;
export const MAX_JOB_BUDGET_MS = 55_000;

export interface JobLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface JobContext {
  /** Registry key, e.g. 'fleet.trucks'. */
  name: string;
  /** Drizzle over the jobs pool (getJobsDb()). */
  db: Db;
  /** The jobs pool itself, for raw SQL (claim_due, LISTEN-free work). Never end() it. */
  pool: pg.Pool;
  log: JobLogger;
  /** Aborted when `deadline` passes or the route is shutting down. Pass it to fetch(). */
  signal: AbortSignal;
  /** Wall-clock now. Injectable in tests; use it instead of `new Date()`. */
  now(): Date;
  /** start + budgetMs. Stop taking new items after this; leave the rest for the next run. */
  deadline: Date;
}

export interface JobResult {
  /** Items processed (written to ingest.job_runs.items). */
  items: number;
  /** Short human note, e.g. 'lease held elsewhere', 'off', '3 dead-lettered'. */
  note?: string;
}

/** Config keys of the connector modes a job can depend on. */
export type JobConnector = 'CONNECTOR_DEERE' | 'CONNECTOR_ELD' | 'CONNECTOR_WEATHER';

interface JobBase {
  /** Default 'app'. */
  host?: JobHost;
  /**
   * Local demo cadence ('1 seconds' … '59 seconds'): with JOBS_DEMO_CADENCE=on (sim connectors
   * only, never production) tools/clock fires the job at this interval instead of its schedule,
   * so the board moves every few seconds (plan §1: "fleet.trucks 30 s; 5 s in local demo mode").
   * `jobs:emit-cron` ignores it: production always uses `every` / `cron`.
   */
  demoEvery?: EverySpec;
  /**
   * The connector setting this job talks through. Its `demoEvery` applies only while that
   * connector is sim, replay or off: a sandbox or live vendor is always polled at the real
   * schedule (call budgets, NWS etiquette), even with JOBS_DEMO_CADENCE=on.
   */
  connector?: JobConnector;
  /** Default DEFAULT_JOB_BUDGET_MS; at most MAX_JOB_BUDGET_MS. */
  budgetMs?: number;
  run(ctx: JobContext): Promise<JobResult>;
}

/** Exactly one of `every` (1-59 seconds) or `cron` (5-field, UTC). */
export type JobDef =
  | (JobBase & { every: EverySpec; cron?: never })
  | (JobBase & { cron: string; every?: never });

/**
 * name -> definition. Names are dotted lower-case ('fleet.trucks', 'weather.nws'); they become
 * the route /api/jobs/<name>, ingest.job_runs.job and the pg_cron job name.
 */
export type JobRegistry = Record<string, JobDef>;
