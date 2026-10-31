/**
 * What deere.ops reads to cap its fields per run under DEERE_DAILY_CALL_BUDGET (decision 4,
 * docs/contracts-1f.md §5.5; the arithmetic is src/connectors/deere/call-shares.ts and
 * src/jobs/deere-ops-budget.ts): the Deere calls per stream on the last full UTC day (in the
 * connector's mode: sim and replay rows never count against a real budget), and the measured
 * `callsPerRun` (sync-health writes it) and `fieldsPerRun` (deere.ops writes it) in the
 * `locations` and `operations` streams' sync_state.extra.
 */
import {
  DEERE_LOCATIONS_STREAM,
  DEERE_OPERATIONS_STREAM,
  lastFullUtcDay,
  type StreamCalls,
} from '../../connectors/deere/call-shares';
import type { CountedMode } from '../../connectors/types';
import { type Executor, exec } from '../exec';

export interface OpsBudgetReadings {
  /** Calls per Deere stream on the last full UTC day, in this mode. */
  lastDay: StreamCalls;
  /** fleet.deere's measured calls per run (null: not measured yet). */
  locationsCallsPerRun: number | null;
  /** deere.ops' measured calls per run and fields per run (null: not measured yet). */
  callsPerRun: number | null;
  fieldsPerRun: number | null;
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
  const calls = await exec<{ stream: string; calls: number }>(
    ex,
    `select stream, sum(calls)::int as calls from ingest.api_calls_daily
      where source = 'deere' and mode = $1 and day = $2::date
      group by stream`,
    [mode, lastFullUtcDay(now)],
  );
  const extras = await exec<{ stream: string; extra: Record<string, unknown> | null }>(
    ex,
    `select stream, extra from ingest.sync_state
      where source = 'deere' and stream = any($1::text[])`,
    [[DEERE_LOCATIONS_STREAM, DEERE_OPERATIONS_STREAM]],
  );
  const extra = (stream: string) => extras.rows.find((r) => r.stream === stream)?.extra ?? {};
  return {
    lastDay: Object.fromEntries(calls.rows.map((r) => [r.stream, Number(r.calls)])),
    locationsCallsPerRun: num(extra(DEERE_LOCATIONS_STREAM).callsPerRun),
    callsPerRun: num(extra(DEERE_OPERATIONS_STREAM).callsPerRun),
    fieldsPerRun: num(extra(DEERE_OPERATIONS_STREAM).fieldsPerRun),
  };
}
