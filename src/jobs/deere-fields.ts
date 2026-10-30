/**
 * deere.fields (slice 1f; owner: the deere-data builder, docs/contracts-1f.md §1, §5.2): every
 * hour (the demo cadence in sim/replay), per Deere org that is connected (decision 5): farms,
 * fields and their active boundaries (D6, decision 7), flags → read-only farm.pins, equipment →
 * farm.machines rows for unmapped Deere machines, engine hours → machines.engine_hours +
 * farm.machine_hours.
 *
 * Foundation stub: registered so the clock and CI stay green while the builder works; it does
 * nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runDeereFields(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
