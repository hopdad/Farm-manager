/**
 * fleet.geotab (slice 1f.2; owner: the trucks builder, docs/contracts-1f.md part B): MyGeotab (CONNECTOR_GEOTAB): GetFeed for LogRecord (positions), StatusData (engine hours, odometer, fuel) and FaultData (J1939 / OBD-II through the Diagnostic lookup) with the stored toVersion (the cursor/version sync model), one Authenticate per session (reused; up to 14 days), within GetFeed 60/min and Authenticate 10/min.
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetGeotab(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
