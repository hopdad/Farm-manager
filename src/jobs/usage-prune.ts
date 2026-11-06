/**
 * usage.prune (slice 2a, decision 2a-11; docs/contracts-2a.md §7.7): deletes app.usage_events
 * rows older than USAGE_RETENTION_DAYS (400 days: the gate report covers a whole planting
 * season with room to spare), in batches, once a day. Registered by the foundation in
 * ./registry.ts (daily, 07:23 UTC: night in Michigan).
 *
 * "Older than 400 days" is by farm day: a row stays while its `farm_day` is on or after the
 * farm date 400 days before today (America/Detroit), so the cutoff never moves with the DST
 * change. The batches stop at the job's deadline (or when the runner aborts the run); whatever
 * is left goes on the next day.
 */
import { pruneUsageEvents } from '../db/queries/usage';
import { farmDate } from '../domain/farm';
import { USAGE_RETENTION_DAYS } from '../domain/work-jobs';
import type { JobContext, JobResult } from './types';

/** The first farm day kept on `now` ('YYYY-MM-DD'): today minus USAGE_RETENTION_DAYS. */
export function usageRetentionCutoff(now: Date): string {
  const [y, m, d] = farmDate(now).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - USAGE_RETENTION_DAYS)).toISOString().slice(0, 10);
}

export async function runUsagePrune(
  ctx: JobContext,
  opts: { batch?: number } = {},
): Promise<JobResult> {
  const cutoff = usageRetentionCutoff(ctx.now());
  const r = await pruneUsageEvents(ctx.pool, cutoff, ctx.deadline, {
    batch: opts.batch,
    clock: () => ctx.now().getTime(),
    signal: ctx.signal,
  });
  const note = `${r.deleted} usage row(s) before ${cutoff} deleted${r.complete ? '' : ' (stopped early: the rest tomorrow)'}`;
  if (r.deleted > 0 || !r.complete) ctx.log.info('usage.prune', { ...r, cutoff });
  return { items: r.deleted, note };
}
