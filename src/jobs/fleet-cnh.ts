/**
 * fleet.cnh (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B): CNH FieldOps scaffolding (CONNECTOR_CNH): OAuth at the CNH identity server, the subscription-key header, the EULA-403 and staging/production states; base URL and paths as config, no fixtures for unconfirmed shapes.
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetCnh(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
