/**
 * The vendor call counter and the Deere call budget (1f decision 4, docs/contracts-1f.md §5.5;
 * owner: sync-health). Ties the HTTP layer's ambient call tally (src/connectors/http.ts) to
 * ingest.api_calls_daily, and turns DEERE_DAILY_CALL_BUDGET into fleet.deere's pace with the
 * shared split (src/connectors/deere/call-shares.ts, the contract both paced jobs and
 * /admin/connectors use):
 *
 *  - Inside a sync step, runSyncStep counts and flushes the step's calls itself (source = the
 *    vendor called, stream and mode = the step's).
 *  - Outside a step, `withCallStream(stream, fn)` counts under its label and hands the tally to
 *    the sink `installCallCounting` installs, which writes it with the CONFIGURED mode of each
 *    vendor (`configuredCallMode`). The CLIs install it before they start
 *    (`connectors:record` → stream 'record'; the deferred `deere:backfill` → 'backfill').
 *  - Sim and replay calls count too, under their own mode: they measure the per-run cost offline
 *    and never count against a real budget (only sandbox/live rows do).
 */
import type { Config } from '../config';
import type { Executor } from '../db/exec';
import {
  type ApiCallRow,
  apiCallsOn,
  callsPerRunOf,
  isCountedMode,
  streamCallsOn,
  upsertApiCalls,
} from '../db/queries/api-calls';
import {
  callsPerDay,
  DEERE_LOCATIONS_STREAM,
  type DeereCallSplit,
  deereCallSplit,
  lastFullUtcDay,
  locationsShare,
  paceSeconds,
  type StreamCalls,
} from './deere/call-shares';
import { CallTally, type CallTallyRow, setCallTallySink, withCallTally } from './http';
import type { Mode } from './types';

/** The connector mode of each vendor name the clients pass to vendorFetch (`opts.vendor`). */
const VENDOR_MODE_KEY = {
  deere: 'CONNECTOR_DEERE',
  samsara: 'CONNECTOR_SAMSARA',
  motive: 'CONNECTOR_MOTIVE',
  geotab: 'CONNECTOR_GEOTAB',
  aemp: 'CONNECTOR_AEMP',
  cnh: 'CONNECTOR_CNH',
  terminal: 'CONNECTOR_TERMINAL',
  nws: 'CONNECTOR_WEATHER',
} as const;

export type CallModeConfig = Partial<
  Pick<Config, (typeof VENDOR_MODE_KEY)[keyof typeof VENDOR_MODE_KEY]>
>;

/** The configured mode of `vendor` (calls outside a step count under it), or null when unknown. */
export function configuredCallMode(cfg: CallModeConfig, vendor: string): Mode | null {
  const key = (VENDOR_MODE_KEY as Record<string, keyof CallModeConfig>)[vendor];
  return key ? (cfg[key] ?? null) : null;
}

/**
 * Tally rows → api_calls_daily rows, with each vendor's mode from `modeOf`. Calls of a vendor
 * whose mode isn't a counted one (off, unknown) are dropped: they can't be stored per mode.
 */
export function apiCallRows(
  rows: readonly CallTallyRow[],
  modeOf: (vendor: string) => Mode | null,
): ApiCallRow[] {
  const out: ApiCallRow[] = [];
  for (const r of rows) {
    const mode = modeOf(r.vendor);
    if (!isCountedMode(mode)) continue;
    out.push({
      source: r.vendor,
      stream: r.stream,
      mode,
      day: r.day,
      calls: r.calls,
      errors: r.errors,
      rateLimited: r.rateLimited,
    });
  }
  return out;
}

/**
 * Count every `withCallStream` scope from now on into ingest.api_calls_daily, each vendor under
 * `modeOf(vendor)` (default: nothing). Returns a function that restores the previous sink.
 *
 *   const stop = installCallCounting(getPool(), (v) => configuredCallMode(cfg, v));
 *   await withCallStream('record', () => work());   // flushed when work() settles
 */
export function installCallCounting(
  ex: Executor,
  modeOf: (vendor: string) => Mode | null,
): () => void {
  const previous = setCallTallySink(async (rows) => {
    await upsertApiCalls(ex, apiCallRows(rows, modeOf));
  });
  return () => {
    setCallTallySink(previous);
  };
}

/**
 * Run `fn` outside any sync step with its vendor calls counted under `stream` (default '': "calls
 * outside a step", e.g. the OAuth callback), each vendor under `modeOf(vendor)`, and add them to
 * ingest.api_calls_daily when `fn` settles. A failed flush is logged, never thrown.
 */
export async function countCalls<T>(
  ex: Executor,
  modeOf: (vendor: string) => Mode | null,
  fn: () => Promise<T>,
  stream = '',
): Promise<T> {
  const tally = new CallTally();
  try {
    return await withCallTally(tally, stream, fn);
  } finally {
    const rows = apiCallRows(tally.drain(), modeOf);
    if (rows.length) {
      await upsertApiCalls(ex, rows).catch((e: unknown) => {
        console.warn(`[call-budget] call counts not saved: ${(e as Error).message}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The Deere budget (decision 4): fleet.deere's pace
// ---------------------------------------------------------------------------------------------

/** Modes whose calls count against DEERE_DAILY_CALL_BUDGET. */
export function budgetCountsIn(mode: Mode): boolean {
  return mode === 'sandbox' || mode === 'live';
}

export interface DeerePace {
  /** True when a minimum interval applies this run. */
  paced: boolean;
  /** Why (or why not), for logs and /admin/connectors. */
  reason: string;
  budget: number | null;
  /** fleet.deere's daily share of the budget (locationsShare), when the budget applies. */
  share: number | null;
  callsPerRun: number | null;
  /** SyncStepSpec.minIntervalSeconds for this run (null = no minimum). */
  minIntervalSeconds: number | null;
}

/**
 * fleet.deere's pace (pure): only with a budget set AND the Deere mode sandbox or live AND a
 * measured calls per run; share = locationsShare(B, D) from the last full UTC day, interval =
 * paceSeconds(callsPerRun, share). runSyncStep never runs the stream faster than its cron.
 */
export function fleetDeerePace(input: {
  budget: number | null | undefined;
  mode: Mode;
  lastDay: StreamCalls;
  callsPerRun: number | null;
}): DeerePace {
  const budget = input.budget ?? null;
  const none = { budget, share: null, callsPerRun: input.callsPerRun, minIntervalSeconds: null };
  if (!budget) {
    return { ...none, paced: false, reason: 'limit unknown (DEERE_DAILY_CALL_BUDGET unset)' };
  }
  if (!budgetCountsIn(input.mode)) {
    return {
      ...none,
      paced: false,
      reason: `${input.mode} calls never count against the budget`,
    };
  }
  const share = locationsShare(budget, input.lastDay);
  const minIntervalSeconds = paceSeconds(input.callsPerRun, share);
  if (minIntervalSeconds === null) {
    return { ...none, share, paced: false, reason: 'calls per run not measured yet' };
  }
  return {
    budget,
    share,
    callsPerRun: input.callsPerRun,
    minIntervalSeconds,
    paced: true,
    reason: `${Math.round(share)} calls a day at ${input.callsPerRun} a run: at most one run every ${minIntervalSeconds} s`,
  };
}

/** Read fleet.deere's pace inputs (last full UTC day's Deere calls in `mode`, calls per run). */
export async function loadFleetDeerePace(
  ex: Executor,
  opts: { budget: number | null | undefined; mode: Mode; now: Date },
): Promise<DeerePace> {
  if (!opts.budget || !budgetCountsIn(opts.mode)) {
    return fleetDeerePace({ ...opts, lastDay: {}, callsPerRun: null });
  }
  const [lastDay, callsPerRun] = await Promise.all([
    streamCallsOn(ex, 'deere', opts.mode, lastFullUtcDay(opts.now)),
    callsPerRunOf(ex, 'deere', DEERE_LOCATIONS_STREAM, opts.mode),
  ]);
  return fleetDeerePace({ budget: opts.budget, mode: opts.mode, lastDay, callsPerRun });
}

// ---------------------------------------------------------------------------------------------
// What /admin/connectors shows
// ---------------------------------------------------------------------------------------------

/** Calls of one source and mode, today and yesterday (UTC), with the per-stream breakdown. */
export interface SourceCalls {
  source: string;
  mode: Mode;
  today: CallCounts;
  yesterday: CallCounts;
  streams: { stream: string; today: CallCounts; yesterday: CallCounts }[];
}

export interface CallCounts {
  calls: number;
  errors: number;
  rateLimited: number;
}

const zero = (): CallCounts => ({ calls: 0, errors: 0, rateLimited: 0 });
const addTo = (c: CallCounts, x: CallCounts) => {
  c.calls += x.calls;
  c.errors += x.errors;
  c.rateLimited += x.rateLimited;
};

/** The UTC day of `now` and the day before, as api_calls_daily.day. */
export function utcDays(now: Date): { today: string; yesterday: string } {
  return { today: now.toISOString().slice(0, 10), yesterday: lastFullUtcDay(now) };
}

/** Today's and yesterday's calls per source and mode (and stream), sources in name order. */
export async function loadSourceCalls(ex: Executor, now: Date): Promise<SourceCalls[]> {
  const { today, yesterday } = utcDays(now);
  const rows = await apiCallsOn(ex, [today, yesterday]);
  const by = new Map<string, SourceCalls>();
  for (const r of rows) {
    const key = `${r.source}|${r.mode}`;
    let s = by.get(key);
    if (!s) {
      s = { source: r.source, mode: r.mode, today: zero(), yesterday: zero(), streams: [] };
      by.set(key, s);
    }
    let st = s.streams.find((x) => x.stream === r.stream);
    if (!st) {
      st = { stream: r.stream, today: zero(), yesterday: zero() };
      s.streams.push(st);
    }
    const which = r.day === today ? 'today' : 'yesterday';
    addTo(s[which], r);
    addTo(st[which], r);
  }
  return [...by.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.mode.localeCompare(b.mode),
  );
}

/** The Deere budget card of /admin/connectors. */
export interface DeereBudgetView {
  /** DEERE_DAILY_CALL_BUDGET, or null ("limit unknown"). */
  budget: number | null;
  mode: Mode;
  /** The budget applies (set, and sandbox/live). */
  applies: boolean;
  /** The split of the last full UTC day (deereCallSplit), when the budget applies. */
  split: DeereCallSplit | null;
  pace: DeerePace;
  /** fleet.deere's cron interval (s), for locations' calls a day at full cadence. */
  cronSeconds: number | null;
  /** The paced interval exceeds FLEET_STALE_SECONDS_DEERE (the board would call Deere stale). */
  staleWarning: string | null;
  lastDay: string;
}

export async function loadDeereBudget(
  ex: Executor,
  opts: {
    budget: number | null | undefined;
    mode: Mode;
    now: Date;
    cronSeconds: number | null;
    staleSecondsDeere: number;
  },
): Promise<DeereBudgetView> {
  const budget = opts.budget ?? null;
  const applies = !!budget && budgetCountsIn(opts.mode);
  const day = lastFullUtcDay(opts.now);
  const [lastDay, callsPerRun] = applies
    ? await Promise.all([
        streamCallsOn(ex, 'deere', opts.mode, day),
        callsPerRunOf(ex, 'deere', DEERE_LOCATIONS_STREAM, opts.mode),
      ])
    : [{}, null];
  const pace = fleetDeerePace({ budget, mode: opts.mode, lastDay, callsPerRun });
  const locationsPerDay =
    callsPerRun && opts.cronSeconds ? callsPerDay(callsPerRun, opts.cronSeconds) : 0;
  const split = applies && budget ? deereCallSplit(budget, lastDay, locationsPerDay) : null;
  const interval = Math.max(pace.minIntervalSeconds ?? 0, opts.cronSeconds ?? 0);
  const staleWarning =
    pace.paced && interval >= opts.staleSecondsDeere
      ? `fleet.deere runs every ${interval} s at this budget, longer than FLEET_STALE_SECONDS_DEERE (${opts.staleSecondsDeere} s): raise FLEET_STALE_SECONDS_DEERE above ${interval} s or the board shows working Deere machines as stale between runs`
      : null;
  return {
    budget,
    mode: opts.mode,
    applies,
    split,
    pace,
    cronSeconds: opts.cronSeconds,
    staleWarning,
    lastDay: day,
  };
}
