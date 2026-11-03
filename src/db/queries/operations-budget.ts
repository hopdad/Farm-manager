/**
 * What deere.ops reads to cap its fields per run under DEERE_DAILY_CALL_BUDGET (decision 4,
 * docs/contracts-1f.md §5.5; the arithmetic is src/connectors/deere/call-shares.ts and
 * src/jobs/deere-ops-budget.ts): the Deere calls per stream on the last full UTC day (in the
 * connector's mode: sim and replay rows never count against a real budget), and the measured
 * `callsPerRun` (sync-health writes it) and `fieldsPerRun` (deere.ops writes it) in the
 * `locations` and `operations` streams' sync_state.extra (callsPerRun only when measured in
 * this mode, `callsPerRunMode`), and the crop seasons per field the runs behind that
 * `callsPerRun` listed (D23: deere.ops' `seasonsRecent`, one entry per successful run, beside
 * sync-health's `callsRecent`; runs it has no entry for listed one season, as before D23).
 */
import {
  DEERE_LOCATIONS_STREAM,
  DEERE_OPERATIONS_STREAM,
  lastFullUtcDay,
  type StreamCalls,
} from '../../connectors/deere/call-shares';
import type { CountedMode } from '../../connectors/types';
import { type Executor, exec } from '../exec';
import { callsPerRunOfExtra, streamCallsOn } from './api-calls';

export interface OpsBudgetReadings {
  /** Calls per Deere stream on the last full UTC day, in this mode. */
  lastDay: StreamCalls;
  /** fleet.deere's measured calls per run (null: not measured yet). */
  locationsCallsPerRun: number | null;
  /** deere.ops' measured calls per run and fields per run (null: not measured yet). */
  callsPerRun: number | null;
  fieldsPerRun: number | null;
  /** The fewest crop seasons per field among the runs behind `callsPerRun` (1 before D23). */
  seasonsMeasured: number;
}

/**
 * The fewest seasons per field among the last `runs` runs (sync-health's `callsRecent`, the
 * runs its mean covers), from deere.ops' `seasonsRecent` (newest last); a run with no entry
 * (written before D23) listed one season. With no runs measured: the newest entry, else 1.
 */
export function seasonsMeasuredOf(runs: number, seasonsRecent: unknown): number {
  const recent = Array.isArray(seasonsRecent)
    ? seasonsRecent.filter((n): n is number => Number.isInteger(n) && n >= 1)
    : [];
  if (runs <= 0) return recent.at(-1) ?? 1;
  const covered = recent.slice(-runs);
  return Math.min(...covered, ...(covered.length < runs ? [1] : []));
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function readOpsBudget(
  ex: Executor,
  mode: CountedMode,
  now: Date,
): Promise<OpsBudgetReadings> {
  const lastDay = await streamCallsOn(ex, 'deere', mode, lastFullUtcDay(now));
  const extras = await exec<{ stream: string; extra: Record<string, unknown> | null }>(
    ex,
    `select stream, extra from ingest.sync_state
      where source = 'deere' and stream = any($1::text[])`,
    [[DEERE_LOCATIONS_STREAM, DEERE_OPERATIONS_STREAM]],
  );
  const extra = (stream: string) => extras.rows.find((r) => r.stream === stream)?.extra ?? {};
  // sync-health's measurement (src/db/queries/api-calls.ts), counted only when it was measured
  // in this mode: a sim run's cost never sizes a sandbox or live budget.
  const callsPerRun = (stream: string) => {
    const m = callsPerRunOfExtra(extra(stream));
    return m.mode === mode ? num(m.callsPerRun) : null;
  };
  const ops = extra(DEERE_OPERATIONS_STREAM);
  const opsCalls = callsPerRunOfExtra(ops);
  return {
    lastDay,
    locationsCallsPerRun: callsPerRun(DEERE_LOCATIONS_STREAM),
    callsPerRun: callsPerRun(DEERE_OPERATIONS_STREAM),
    fieldsPerRun: num(ops.fieldsPerRun),
    seasonsMeasured: seasonsMeasuredOf(
      opsCalls.mode === mode ? Math.max(opsCalls.recent.length, opsCalls.callsPerRun ? 1 : 0) : 0,
      ops.seasonsRecent,
    ),
  };
}
