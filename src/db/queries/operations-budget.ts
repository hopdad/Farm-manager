/**
 * What deere.ops reads to cap its fields per run under DEERE_DAILY_CALL_BUDGET (decision 4,
 * docs/contracts-1f.md §5.5; the arithmetic is src/connectors/deere/call-shares.ts and
 * src/jobs/deere-ops-budget.ts): the Deere calls per stream on the last full UTC day (in the
 * connector's mode: sim and replay rows never count against a real budget), fleet.deere's
 * measured `callsPerRun`, and deere.ops' recent successful runs (`runsRecent`: each run's calls,
 * the fields it checked and the crop seasons it listed per field, kept together by sync-health
 * beside `callsRecent`, D23), all in this mode (`callsPerRunMode`). Until deere.ops has kept a
 * run (runs from before D23): its `callsPerRun` and the last run's `fieldsPerRun` (deere.ops
 * writes it), runs that listed one season a field.
 */
import {
  DEERE_LOCATIONS_STREAM,
  DEERE_OPERATIONS_STREAM,
  lastFullUtcDay,
  type OpsRunCost,
  type StreamCalls,
} from '../../connectors/deere/call-shares';
import type { CountedMode } from '../../connectors/types';
import { type Executor, exec } from '../exec';
import { callsPerRunOfExtra, type RunRecord, streamCallsOn } from './api-calls';

export interface OpsBudgetReadings {
  /** Calls per Deere stream on the last full UTC day, in this mode. */
  lastDay: StreamCalls;
  /** fleet.deere's measured calls per run (null: not measured yet). */
  locationsCallsPerRun: number | null;
  /** deere.ops' recent successful runs in this mode, oldest first ([] before D23). */
  runs: OpsRunCost[];
  /** deere.ops' measured calls per run and the last run's fields (null: not measured yet). */
  callsPerRun: number | null;
  fieldsPerRun: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A kept run as deere.ops records it (`fields`, `seasons` ≥ 1), or null. */
function opsRunOf(r: RunRecord): OpsRunCost | null {
  const { calls, fields, seasons } = r;
  if (fields === undefined || seasons === undefined || !Number.isInteger(seasons) || seasons < 1) {
    return null;
  }
  return { calls, fields, seasons };
}

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
  const measured = (stream: string) => {
    const m = callsPerRunOfExtra(extra(stream));
    return m.mode === mode ? m : null;
  };
  const ops = measured(DEERE_OPERATIONS_STREAM);
  return {
    lastDay,
    locationsCallsPerRun: num(measured(DEERE_LOCATIONS_STREAM)?.callsPerRun),
    runs: (ops?.runs ?? []).map(opsRunOf).filter((r): r is OpsRunCost => r !== null),
    callsPerRun: num(ops?.callsPerRun),
    fieldsPerRun: num(extra(DEERE_OPERATIONS_STREAM).fieldsPerRun),
  };
}
