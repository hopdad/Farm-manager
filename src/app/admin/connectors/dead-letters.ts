/**
 * Dead-lettered raw events (ingest.raw_events status 'dead': an event that failed `map` or
 * `upsert` 5 times, docs/contracts.md §8) and what a manager can do with them on
 * /admin/connectors (1f, sync-health):
 *
 *  - requeue: back to 'pending' with its attempts reset, so the stream's next run tries it again
 *    (with the code or the data fixed in the meantime);
 *  - discard: marked 'processed' with the reason kept in last_error ("discarded on
 *    /admin/connectors by <name>"), so the same payload never lands again (raw events dedupe by
 *    sha256) and it leaves the dead list. Nothing is deleted.
 *
 * Only rows still 'dead' are touched. Callers check the role first (ROLE_FOR.admin).
 */
import { z } from 'zod';
import { type Executor, exec } from '../../../db/exec';

/** Which dead events: some ids, or every one (optionally of one source / stream). */
export const deadSelectionSchema = z.union([
  z.strictObject({ ids: z.array(z.uuid()).min(1).max(500) }),
  z.strictObject({
    all: z.literal(true),
    source: z.string().min(1).max(40).optional(),
    stream: z.string().min(1).max(80).optional(),
  }),
]);
export type DeadSelection = z.infer<typeof deadSelectionSchema>;

export const deadLetterRequestSchema = z.intersection(
  z.object({ action: z.enum(['requeue', 'discard']) }),
  deadSelectionSchema,
);
export type DeadLetterRequest = z.infer<typeof deadLetterRequestSchema>;

function where(sel: DeadSelection): { sql: string; params: unknown[] } {
  if ('ids' in sel) return { sql: `status = 'dead' and id = any($1::uuid[])`, params: [sel.ids] };
  const params: unknown[] = [];
  let sql = `status = 'dead'`;
  if (sel.source) {
    params.push(sel.source);
    sql += ` and source = $${params.length}`;
  }
  if (sel.stream) {
    params.push(sel.stream);
    sql += ` and stream = $${params.length}`;
  }
  return { sql, params };
}

/** Requeue: 'pending', attempts 0 (the next run of its stream processes it). Returns the count. */
export async function requeueDead(ex: Executor, sel: DeadSelection): Promise<number> {
  const w = where(sel);
  const r = await exec(
    ex,
    `update ingest.raw_events set status = 'pending', attempts = 0, processed_at = null
      where ${w.sql}`,
    w.params,
  );
  return r.rowCount;
}

/** Discard: 'processed' with the reason prepended to last_error. Returns the count. */
export async function discardDead(ex: Executor, sel: DeadSelection, by: string): Promise<number> {
  const w = where(sel);
  const reason = `discarded on /admin/connectors by ${by.slice(0, 80)}`;
  const r = await exec(
    ex,
    `update ingest.raw_events
        set status = 'processed', processed_at = now(),
            last_error = left($${w.params.length + 1} || coalesce(': ' || last_error, ''), 300)
      where ${w.sql}`,
    [...w.params, reason],
  );
  return r.rowCount;
}

/** Dead events per source and stream, plus the total (the page's count). */
export async function deadCounts(
  ex: Executor,
): Promise<{ total: number; byStream: { source: string; stream: string; count: number }[] }> {
  const r = await exec<{ source: string; stream: string; n: number }>(
    ex,
    `select source, stream, count(*)::int as n from ingest.raw_events
      where status = 'dead' group by source, stream order by source, stream`,
  );
  const byStream = r.rows.map((x) => ({ source: x.source, stream: x.stream, count: Number(x.n) }));
  return { total: byStream.reduce((n, x) => n + x.count, 0), byStream };
}
