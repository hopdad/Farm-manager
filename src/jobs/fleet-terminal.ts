/**
 * fleet.terminal (slice 1f.2; owner: the terminal-pickups builder, docs/contracts-1f.md part B): the Terminal adapter (CONNECTOR_TERMINAL): the normalized API with the Connection-Token header (latest vehicle locations, stats, fault code events, /providers for the capability matrix); stand-in only until sandbox access.
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetTerminal(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
