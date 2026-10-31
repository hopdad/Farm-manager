/**
 * deere.ops' per-run field cap (decision 4, docs/contracts-1f.md §5.5), pure: with
 * DEERE_DAILY_CALL_BUDGET = B set and the Deere mode sandbox or live,
 *
 *   share     = operationsShare(B, D, locations' calls a day at fleet.deere's cron)
 *   fields    = operationsFieldCap(share, runs a day at deere.ops' cron, callsPerRun / fieldsPerRun)
 *
 * (src/connectors/deere/call-shares.ts). Unset budget, sim / replay / off, or nothing measured
 * yet (no callsPerRun or fieldsPerRun) = no cap: every field every run. Locations not measured
 * count as 0 a day (they get their own floor in their own pacing).
 */
import {
  callsPerDay,
  operationsFieldCap,
  operationsShare,
  type StreamCalls,
} from '../connectors/deere/call-shares';
import type { Mode } from '../connectors/types';

/** fleet.deere's cron interval (every 2 minutes, src/jobs/registry.ts). */
export const FLEET_DEERE_CRON_SECONDS = 120;
/** deere.ops' cron interval (every 15 minutes, src/jobs/registry.ts). */
export const DEERE_OPS_CRON_SECONDS = 900;

export interface OpsCapInputs {
  budget: number | null | undefined;
  mode: Mode;
  lastDay: StreamCalls;
  locationsCallsPerRun: number | null;
  callsPerRun: number | null;
  fieldsPerRun: number | null;
}

export function opsFieldCap(i: OpsCapInputs): number | null {
  if (!i.budget || i.budget < 1) return null;
  if (i.mode !== 'sandbox' && i.mode !== 'live') return null;
  if (!i.callsPerRun || !i.fieldsPerRun) return null;
  const locationsPerDay = i.locationsCallsPerRun
    ? callsPerDay(i.locationsCallsPerRun, FLEET_DEERE_CRON_SECONDS)
    : 0;
  const share = operationsShare(i.budget, i.lastDay, locationsPerDay);
  return operationsFieldCap(share, 86_400 / DEERE_OPS_CRON_SECONDS, i.callsPerRun / i.fieldsPerRun);
}
