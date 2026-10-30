/**
 * fleet.aemp (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B): the generic ISO 15143-3 (AEMP 2.0) client (CONNECTOR_AEMP), per configured provider (AEMP_PROVIDERS; in sim the stand-in's cnh, kubota and samsara): Fleet pages → last-known positions (positionKind last_known, provider = the AEMP provider) and stats (hours, fuel, DEF, odometer, engine state; the snapshot-diff sync model), fault time series where a provider has them.
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetAemp(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
