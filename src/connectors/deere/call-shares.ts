/**
 * How the Deere jobs share DEERE_DAILY_CALL_BUDGET (1f decision 4, docs/contracts-1f.md §5.5).
 * Pure arithmetic both paced jobs and /admin/connectors use, so they agree: fleet.deere
 * (sync-health) paces its `locations` stream, deere.ops (deere-ops) caps the fields it checks per
 * run, the page shows the split. Callers read the counts themselves from ingest.api_calls_daily:
 * the LAST FULL UTC DAY (`lastFullUtcDay`), source 'deere', the current mode, and only when that
 * mode is sandbox or live (sim and replay calls never count against a real budget).
 *
 * With B = the budget and D = the last full day's calls per Deere stream:
 *
 *   locations   share = max(10 % B, 80 % B − Σ D[every other Deere stream])
 *               minIntervalSeconds = ceil(callsPerRun × 86 400 / share)
 *   operations  share = max(10 % B, 80 % B − Σ D[streams other than locations and operations]
 *                                          − locations' calls a day at its cron)
 *               fields per run = max(1, floor(share / (runs a day × calls per field))),
 *               the fields checked longest ago first
 *
 * Locations come first (the live board): operations get what is left after the unpaced streams
 * and locations at full cadence, so the two paced streams never both plan on the same calls.
 * `runSyncStep` never runs a stream faster than its cron, whatever the interval. Unmeasured
 * (no runs counted yet) = no limit from here. Owned by the 1f foundation (contract file).
 */

/** Share of the budget the app plans to spend; the rest is headroom (retries, a CLI run, a re-sign-in). */
export const DEERE_BUDGET_TARGET = 0.8;
/** No paced stream plans on less than this share of the budget, whatever the others spent. */
export const DEERE_BUDGET_FLOOR = 0.1;

/** sync_state / api_calls_daily stream of fleet.deere (machine locations). */
export const DEERE_LOCATIONS_STREAM = 'locations';
/** Stream of deere.ops (field operations). */
export const DEERE_OPERATIONS_STREAM = 'operations';

/** Calls per stream on one UTC day (ingest.api_calls_daily rows of one source and mode). */
export type StreamCalls = Readonly<Record<string, number>>;

const DAY_SECONDS = 86_400;

/** The last full UTC day before `now`, as api_calls_daily.day ('YYYY-MM-DD'). */
export function lastFullUtcDay(now: Date): string {
  return new Date(now.getTime() - DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

const count = (c: number | undefined): number =>
  c !== undefined && Number.isFinite(c) && c > 0 ? c : 0;

function sumExcept(calls: StreamCalls, except: readonly string[]): number {
  let n = 0;
  for (const [stream, c] of Object.entries(calls)) if (!except.includes(stream)) n += count(c);
  return n;
}

const floor = (budget: number) => DEERE_BUDGET_FLOOR * budget;
const target = (budget: number) => DEERE_BUDGET_TARGET * budget;

/** Calls a day a stream makes at `callsPerRun` every `intervalSeconds`. */
export function callsPerDay(callsPerRun: number, intervalSeconds: number): number {
  return (callsPerRun * DAY_SECONDS) / intervalSeconds;
}

/** fleet.deere's daily share of the budget. */
export function locationsShare(budget: number, lastDay: StreamCalls): number {
  return Math.max(floor(budget), target(budget) - sumExcept(lastDay, [DEERE_LOCATIONS_STREAM]));
}

/** deere.ops's daily share: what is left after the unpaced streams and locations at full cadence. */
export function operationsShare(
  budget: number,
  lastDay: StreamCalls,
  locationsPerDayAtCron: number,
): number {
  const unpaced = sumExcept(lastDay, [DEERE_LOCATIONS_STREAM, DEERE_OPERATIONS_STREAM]);
  return Math.max(floor(budget), target(budget) - unpaced - Math.max(0, locationsPerDayAtCron));
}

/**
 * The SyncStepSpec.minIntervalSeconds that keeps `callsPerRun` within `share` a day; null when
 * nothing is measured yet (no minimum). Below the cron interval it has no effect.
 */
export function paceSeconds(callsPerRun: number | null, share: number): number | null {
  if (!callsPerRun || callsPerRun <= 0 || !(share > 0)) return null;
  return Math.ceil((callsPerRun * DAY_SECONDS) / share);
}

/** Fields deere.ops may check in one run (at least 1); null when calls per field aren't measured. */
export function operationsFieldCap(
  share: number,
  runsPerDay: number,
  callsPerField: number | null,
): number | null {
  if (!callsPerField || callsPerField <= 0 || !(runsPerDay > 0)) return null;
  return Math.max(1, Math.floor(share / (runsPerDay * callsPerField)));
}

/** What /admin/connectors shows for the Deere budget. */
export interface DeereCallSplit {
  budget: number;
  /** 80 % of the budget. */
  target: number;
  lastDay: { locations: number; operations: number; others: number };
  shares: { locations: number; operations: number };
  /** The streams other than locations alone spent more than the target (locations at its floor). */
  othersOverTarget: boolean;
}

export function deereCallSplit(
  budget: number,
  lastDay: StreamCalls,
  locationsPerDayAtCron: number,
): DeereCallSplit {
  return {
    budget,
    target: target(budget),
    lastDay: {
      locations: count(lastDay[DEERE_LOCATIONS_STREAM]),
      operations: count(lastDay[DEERE_OPERATIONS_STREAM]),
      others: sumExcept(lastDay, [DEERE_LOCATIONS_STREAM, DEERE_OPERATIONS_STREAM]),
    },
    shares: {
      locations: locationsShare(budget, lastDay),
      operations: operationsShare(budget, lastDay, locationsPerDayAtCron),
    },
    othersOverTarget: sumExcept(lastDay, [DEERE_LOCATIONS_STREAM]) > target(budget),
  };
}
