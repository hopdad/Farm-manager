/**
 * What deere.ops reads to cap its fields per run under DEERE_DAILY_CALL_BUDGET (decision 4,
 * docs/contracts-1f.md §5.5; the arithmetic is src/connectors/deere/call-shares.ts and
 * src/jobs/deere-ops-budget.ts): the Deere calls per stream on the last full UTC day (in the
 * connector's mode: sim and replay rows never count against a real budget), and the measured
 * `callsPerRun` (sync-health writes it) and `fieldsPerRun` (deere.ops writes it) in the
 * `locations` and `operations` streams' sync_state.extra (callsPerRun only when measured in
 * this mode, `callsPerRunMode`).
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
  return {
    lastDay,
    locationsCallsPerRun: callsPerRun(DEERE_LOCATIONS_STREAM),
    callsPerRun: callsPerRun(DEERE_OPERATIONS_STREAM),
    fieldsPerRun: num(extra(DEERE_OPERATIONS_STREAM).fieldsPerRun),
  };
}
