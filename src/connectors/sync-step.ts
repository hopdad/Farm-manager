/**
 * runSyncStep: the one sync step every source uses (plan §5 "Common shape", contracts §8).
 *
 *   0. ensureStream(pool, source, stream, mode); mode 'off' → { claimed: false, skipped: 'off' }
 *   1. claimDue(pool, source, stream, leaseSeconds ?? 90); null → skipped 'lease held elsewhere'
 *   2-3. poll(cursor) → ONE transaction lands the raw items in ingest.raw_events (sha256 dedupe)
 *      and advanceCursor(tx, lease, cursor) (false → roll back: 'lease lost'). While the vendor
 *      says `hasMore`, poll again (each page its own transaction), within the job's deadline.
 *   4. process pending events one at a time, each in its own transaction: map (pure) → upsert
 *      (savepoint) → processed; a failure counts an attempt, `maxAttempts` → dead; an event that
 *      failed is not retried in the same run; stop taking new ones after ctx.deadline.
 *   5. releaseLease(pool, lease, { ok, error, nextRunAt = retryAfterFrom(err, now) })
 *   6. afterRun(result) whenever claimed, ok or not (one batched fleet.tick).
 *
 * After the claim it never throws for poll, landing, lease-lost or processing failures; it
 * returns `{ claimed: true, ok: false, error }` (contracts §8 failure rules).
 */
import { createHash } from 'node:crypto';
import { exec } from '../db/exec';
import {
  advanceCursor,
  type ClaimedLease,
  claimDue,
  cursorOf,
  DEFAULT_STREAM_LEASE_SECONDS,
  ensureStream,
  releaseLease,
} from '../db/leases';
import type { JobContext } from '../jobs/types';
import {
  type RawItem,
  type RunSyncStep,
  retryAfterFrom,
  type SyncContext,
  type SyncStepResult,
  type SyncStepSpec,
} from './types';

export const DEFAULT_MAX_ATTEMPTS = 5;
/** Pages one run may land (hasMore loops) before leaving the rest to the next run. */
export const MAX_PAGES_PER_RUN = 20;
/** Rows per landing INSERT. */
const LANDING_CHUNK = 500;
/** Keep error text short (sync_state.last_error, job_runs.error). */
const MAX_ERROR_CHARS = 300;

class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}

/** Short, single-line error text (no stack, no payloads). */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.replace(/\s+/g, ' ').trim() || 'unknown error';
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 3)}...` : line;
}

/** Deterministic JSON (sorted keys) so equal payloads hash equally whatever their key order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
}

export function payloadSha256(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** Land one page and advance the cursor in ONE transaction. Returns rows newly inserted. */
async function landPage(
  ctx: JobContext,
  lease: ClaimedLease,
  source: string,
  stream: string,
  items: RawItem<unknown>[],
  cursor: string,
): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    let landed = 0;
    for (let i = 0; i < items.length; i += LANDING_CHUNK) {
      const chunk = items.slice(i, i + LANDING_CHUNK).map((it) => ({
        e: it.externalId,
        p: it.payload,
        s: payloadSha256(it.payload),
      }));
      const r = await exec(
        tx,
        `insert into ingest.raw_events (source, stream, external_id, payload, sha256)
         select $1, $2, x->>'e', x->'p', x->>'s' from jsonb_array_elements($3::jsonb) as x
         on conflict (source, stream, external_id, sha256) do nothing`,
        [source, stream, JSON.stringify(chunk)],
      );
      landed += r.rowCount;
    }
    if (!(await advanceCursor(tx, lease, cursor))) throw new LeaseLostError();
    return landed;
  });
}

interface PendingRow {
  id: string;
  payload: unknown;
  attempts: number;
}

/**
 * Process pending raw events one at a time until none are left or the deadline passes. Order:
 * page by page (fetched_at), then by external_id: every connector's ends in the ISO time of its
 * series (`<vehicle>:<iso>`, `<vehicle>:<type>:<iso>`, `<org>:<machine>:<iso>`), so within a page
 * each series is applied oldest first and "latest wins" updates (fuel) end at the newest value.
 */
async function processPending<TRaw, TNorm>(
  spec: SyncStepSpec<TRaw, TNorm>,
  sctx: SyncContext,
): Promise<{ processed: number; dead: number }> {
  const ctx = sctx.job;
  const maxAttempts = spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const failedThisRun: string[] = [];
  let processed = 0;
  let dead = 0;
  for (;;) {
    if (ctx.signal.aborted || ctx.now().getTime() >= ctx.deadline.getTime()) break;
    const done = await ctx.db.transaction(async (tx) => {
      const r = await exec<PendingRow>(
        tx,
        `select id::text as id, payload, attempts from ingest.raw_events
          where source = $1 and stream = $2 and status = 'pending'
            and not (id = any($3::uuid[]))
          order by fetched_at, external_id, id
          limit 1
          for update skip locked`,
        [spec.source, spec.stream, failedThisRun],
      );
      const row = r.rows[0];
      if (!row) return true;
      try {
        await tx.transaction(async (sp) => {
          for (const item of spec.map(row.payload as TRaw, sctx)) {
            await spec.upsert(sp, item, sctx);
          }
        });
        await exec(
          tx,
          `update ingest.raw_events
              set status = 'processed', processed_at = now(), attempts = attempts + 1,
                  last_error = null
            where id = $1::uuid`,
          [row.id],
        );
        processed++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const isDead = attempts >= maxAttempts;
        await exec(
          tx,
          `update ingest.raw_events
              set attempts = $2, last_error = $3, status = $4
            where id = $1::uuid`,
          [row.id, attempts, errorText(e), isDead ? 'dead' : 'pending'],
        );
        failedThisRun.push(row.id);
        if (isDead) dead++;
        ctx.log.warn('raw event failed', {
          source: spec.source,
          stream: spec.stream,
          id: row.id,
          attempts,
          dead: isDead,
          error: errorText(e),
        });
      }
      return false;
    });
    if (done) break;
  }
  return { processed, dead };
}

export const runSyncStep: RunSyncStep = async (spec, ctx) => {
  const sctx: SyncContext = { job: ctx, source: spec.source, stream: spec.stream, mode: spec.mode };
  // 0-1: database errors here throw (nothing is held yet).
  await ensureStream(ctx.pool, spec.source, spec.stream, spec.mode);
  if (spec.mode === 'off') {
    return {
      claimed: false,
      ok: true,
      skipped: 'off',
      landed: 0,
      processed: 0,
      dead: 0,
      cursor: null,
    };
  }
  const lease = await claimDue(
    ctx.pool,
    spec.source,
    spec.stream,
    spec.leaseSeconds ?? DEFAULT_STREAM_LEASE_SECONDS,
  );
  if (!lease) {
    return {
      claimed: false,
      ok: true,
      skipped: 'lease held elsewhere',
      landed: 0,
      processed: 0,
      dead: 0,
      cursor: null,
    };
  }

  let cursor = cursorOf(lease);
  let landed = 0;
  let error: string | undefined;
  let nextRunAt: Date | null = null;
  let leaseLost = false;

  // 2-3: poll and land, page by page.
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      if (page > 0 && (ctx.signal.aborted || ctx.now().getTime() >= ctx.deadline.getTime())) break;
      const res = await spec.poll(cursor, sctx);
      landed += await landPage(ctx, lease, spec.source, spec.stream, res.items, res.cursor);
      cursor = res.cursor;
      if (!res.hasMore) break;
    }
  } catch (e) {
    leaseLost = e instanceof LeaseLostError;
    error = leaseLost ? 'lease lost' : errorText(e);
    nextRunAt = leaseLost ? null : retryAfterFrom(e, ctx.now());
    ctx.log.warn('sync poll failed', { source: spec.source, stream: spec.stream, error });
  }

  // 4: process (also after a failed poll: earlier pages may be pending); not after losing the
  // lease (another runner owns the stream now).
  let processed = 0;
  let dead = 0;
  if (!leaseLost) {
    try {
      ({ processed, dead } = await processPending(spec, sctx));
    } catch (e) {
      error ??= `processing: ${errorText(e)}`;
      ctx.log.error('sync processing failed', { source: spec.source, stream: spec.stream, error });
    }
  }

  // 5: release (a failure here is logged; the lease then simply expires).
  try {
    const released = await releaseLease(ctx.pool, lease, { ok: !error, error, nextRunAt });
    if (!released && !leaseLost) {
      ctx.log.warn('stream lease expired before release', {
        source: spec.source,
        stream: spec.stream,
      });
    }
  } catch (e) {
    ctx.log.error('releaseLease failed', {
      source: spec.source,
      stream: spec.stream,
      error: errorText(e),
    });
    error ??= `release: ${errorText(e)}`;
  }

  const result: SyncStepResult = {
    claimed: true,
    ok: !error,
    ...(error ? { error } : {}),
    landed,
    processed,
    dead,
    cursor,
  };

  // 6: afterRun whenever claimed.
  if (spec.afterRun) {
    try {
      await spec.afterRun(result, sctx);
    } catch (e) {
      const msg = `afterRun: ${errorText(e)}`;
      ctx.log.error('sync afterRun failed', {
        source: spec.source,
        stream: spec.stream,
        error: msg,
      });
      result.ok = false;
      result.error = msg;
    }
  }
  return result;
};
