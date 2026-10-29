/**
 * Leases on ingest.sync_state rows: the ONE way the jobs route and the sync step claim, advance
 * and release work (wrappers over app.ensure_stream / app.claim_due / app.release_lease from
 * db/migrations/0002). Plan §1: "Claim a lease with one UPDATE … RETURNING".
 *
 * Two lease levels, never the same row (docs/contracts.md §5 and §8):
 *
 *  1. JOB lease, taken by POST /api/jobs/<name> BEFORE it answers 202, on the row
 *     (source 'job', stream <job name>, mode 'live'):
 *        await ensureStream(pool, JOB_LEASE_SOURCE, name, JOB_LEASE_MODE);
 *        const lease = await claimDue(pool, JOB_LEASE_SOURCE, name, jobLeaseSeconds(budgetMs));
 *        if (!lease) return 202 { skipped: 'busy' };          // another run of this job is in flight
 *        … 202, then in after(): run(ctx) …
 *        await releaseLease(pool, lease, { ok, error });
 *     It stops the clock (or pg_cron) from overlapping two runs of one job.
 *
 *  2. STREAM lease, taken by runSyncStep INSIDE run(ctx), on (connector source, stream), e.g.
 *     ('samsara', 'positions'). It guards the cursor: two jobs (or a webhook nudge plus the
 *     clock) can never land the same page twice. If claimDue returns null, runSyncStep returns
 *     `claimed: false` and the job returns `{ items: 0, note: 'lease held elsewhere' }`.
 *
 * Cursors are stored in sync_state.cursor as a JSON string (`"abc"`), read with cursorOf().
 * All helpers take a pg Pool/PoolClient or a Drizzle db/tx (src/db/exec.ts).
 */
import type { Mode } from '../connectors/types';
import { type Executor, exec, toDate } from './exec';

/** `source` of job-level lease rows in ingest.sync_state (stream = the job name). */
export const JOB_LEASE_SOURCE = 'job';
/** Mode of job-level lease rows (claim_due never claims mode 'off'). */
export const JOB_LEASE_MODE: Mode = 'live';
/** Extra seconds a job lease outlives the job's budget (after() start-up, release round trip). */
export const JOB_LEASE_MARGIN_SECONDS = 30;
/** Default stream lease (runSyncStep), longer than the 55 s maximum job budget. */
export const DEFAULT_STREAM_LEASE_SECONDS = 90;

/** Lease length for a job with this budget: ceil(budgetMs / 1000) + 30. */
export function jobLeaseSeconds(budgetMs: number): number {
  return Math.ceil(budgetMs / 1000) + JOB_LEASE_MARGIN_SECONDS;
}

/** A claimed ingest.sync_state row (camelCase). Build it from a raw row with toClaimedLease(). */
export interface ClaimedLease {
  source: string;
  stream: string;
  mode: Mode;
  /** sync_state.cursor (jsonb). Connector cursors are JSON strings: use cursorOf(lease). */
  cursor: unknown;
  leaseUntil: Date;
  leaseToken: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  extra: Record<string, unknown>;
}

/** Raw row of `select * from app.claim_due(...)` (snake_case, as pg returns it). */
export interface SyncStateRow {
  source: string;
  stream: string;
  mode: string;
  cursor: unknown;
  lease_until: Date | string | null;
  lease_token: string | null;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  last_ok_at: Date | string | null;
  last_error: string | null;
  last_error_at: Date | string | null;
  extra: Record<string, unknown> | null;
  updated_at?: Date | string | null;
}

/** snake_case sync_state row -> ClaimedLease. Throws if the row holds no lease. */
export function toClaimedLease(row: SyncStateRow): ClaimedLease {
  const leaseUntil = toDate(row.lease_until);
  if (!leaseUntil || !row.lease_token) {
    throw new Error(`sync_state ${row.source}/${row.stream} holds no lease`);
  }
  return {
    source: row.source,
    stream: row.stream,
    mode: row.mode as Mode,
    cursor: row.cursor ?? null,
    leaseUntil,
    leaseToken: row.lease_token,
    nextRunAt: toDate(row.next_run_at),
    lastRunAt: toDate(row.last_run_at),
    lastOkAt: toDate(row.last_ok_at),
    lastError: row.last_error ?? null,
    lastErrorAt: toDate(row.last_error_at),
    extra: row.extra ?? {},
  };
}

/** The connector cursor of a lease: the stored JSON string, or null (first run). */
export function cursorOf(lease: Pick<ClaimedLease, 'cursor'>): string | null {
  return typeof lease.cursor === 'string' ? lease.cursor : null;
}

/** Create the sync_state row if missing; update its mode if it differs (app.ensure_stream). */
export async function ensureStream(
  ex: Executor,
  source: string,
  stream: string,
  mode: Mode,
): Promise<void> {
  await exec(ex, 'select app.ensure_stream($1, $2, $3)', [source, stream, mode]);
}

/**
 * Claim the row's lease (app.claim_due). Null when the mode is 'off', an unexpired lease is held,
 * next_run_at is in the future, or the row doesn't exist (call ensureStream first).
 */
export async function claimDue(
  ex: Executor,
  source: string,
  stream: string,
  leaseSeconds: number,
): Promise<ClaimedLease | null> {
  const secs = Math.ceil(leaseSeconds);
  if (!(secs > 0)) throw new RangeError('leaseSeconds must be > 0');
  const r = await exec<SyncStateRow>(ex, 'select * from app.claim_due($1, $2, $3)', [
    source,
    stream,
    secs,
  ]);
  const row = r.rows[0];
  return row ? toClaimedLease(row) : null;
}

export interface LeaseOutcome {
  ok: boolean;
  /** Recorded in last_error when !ok (keep it short; no secrets). */
  error?: string | null;
  /** Not due before this (backoff, Retry-After); null/omitted = due again right away. */
  nextRunAt?: Date | null;
}

/**
 * Release a lease and record the outcome (app.release_lease). Returns false when the token no
 * longer matches (the lease expired and someone else claimed the row): log it, don't throw.
 */
export async function releaseLease(
  ex: Executor,
  lease: Pick<ClaimedLease, 'source' | 'stream' | 'leaseToken'>,
  outcome: LeaseOutcome,
): Promise<boolean> {
  const r = await exec<{ released: boolean }>(
    ex,
    'select app.release_lease($1, $2, $3::uuid, $4, $5, $6::timestamptz) as released',
    [
      lease.source,
      lease.stream,
      lease.leaseToken,
      outcome.ok,
      outcome.ok ? null : (outcome.error ?? 'failed'),
      outcome.nextRunAt ? outcome.nextRunAt.toISOString() : null,
    ],
  );
  return r.rows[0]?.released === true;
}

/**
 * Store the next cursor while still holding the lease (call it in the same transaction that
 * lands the raw events). Returns false when the lease was lost: roll that transaction back.
 */
export async function advanceCursor(
  ex: Executor,
  lease: Pick<ClaimedLease, 'source' | 'stream' | 'leaseToken'>,
  cursor: string | null,
): Promise<boolean> {
  const r = await exec(
    ex,
    `update ingest.sync_state
        set cursor = $4::jsonb, updated_at = now()
      where source = $1 and stream = $2 and lease_token = $3::uuid`,
    [lease.source, lease.stream, lease.leaseToken, cursor === null ? null : JSON.stringify(cursor)],
  );
  return r.rowCount === 1;
}
