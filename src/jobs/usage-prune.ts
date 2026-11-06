/**
 * usage.prune (slice 2a, decision 2a-11; docs/contracts-2a.md §7.7): deletes app.usage_events
 * rows older than USAGE_RETENTION_DAYS (400 days: the gate report covers a whole planting
 * season with room to spare), in batches, once a day. Registered by the foundation in
 * ./registry.ts.
 *
 * FOUNDATION STUB, owned by the rights-usage builder: deletes nothing yet. Keep the export.
 */
import type { JobContext, JobResult } from './types';

export async function runUsagePrune(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
