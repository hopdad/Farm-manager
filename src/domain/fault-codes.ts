/**
 * Vehicle fault codes (DTCs, engine faults; slice 1f). Not to be confused with the stand-in's
 * "faults" (vendor API fault injection, src/sim/vendors/faults.ts): these are the codes a truck's
 * ECU reports through the ELD (Samsara `faultCodes` stats; Motive is unsupported until D3).
 *
 *  - The ELD stats feed maps each event to `NormalizedVehicleStat.faultCodes` (src/connectors/
 *    types.ts): the machine's ACTIVE codes at that instant; `[]` = cleared (an event with no codes
 *    and no lamps), `undefined` = the event says nothing about faults.
 *  - `farm.machine_faults` keeps the history (one open row per machine, source and code);
 *    `farm.machine_state.fault_codes` the current summary (`ActiveFaultCode[]`, worst first),
 *    guarded by `faults_at` so an older page never brings a cleared fault back.
 *  - Severity policy (decision 2, docs/contracts-1f.md): critical = J1939 red stop lamp; warning =
 *    amber warning or protect lamp, emissions lamp, OBD MIL on, confirmed DTCs; info = pending
 *    DTCs. A critical fault never marks a machine down by itself: it OFFERS "Critical fault: mark
 *    down?" to a driver and above.
 *
 * Pure TS + zod. Owned by the 1f foundation (contract file).
 */
import { z } from 'zod';

/** Lowest first. */
export const FAULT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type FaultSeverity = (typeof FAULT_SEVERITIES)[number];

/** One active code as a vendor reports it. */
export interface FaultCode {
  /** 'J1939 SPN 110 FMI 0', an OBD short code ('P0217'), … (stable per fault: the history key). */
  code: string;
  severity: FaultSeverity;
  description: string | null;
}

/** An active code with the time it was first seen (machine_state.fault_codes, the panel). */
export interface ActiveFaultCode extends FaultCode {
  /** UTC ISO: first_seen_at of its open farm.machine_faults row. */
  since: string;
}

export const faultCodeSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(FAULT_SEVERITIES),
  description: z.string().nullable(),
}) satisfies z.ZodType<FaultCode>;

export const activeFaultCodeSchema = faultCodeSchema.extend({
  since: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<ActiveFaultCode>;

export function severityRank(s: FaultSeverity): number {
  return FAULT_SEVERITIES.indexOf(s);
}

/** The worst severity among `codes`, or null when there are none. */
export function worstSeverity(codes: readonly Pick<FaultCode, 'severity'>[]): FaultSeverity | null {
  let worst: FaultSeverity | null = null;
  for (const c of codes) {
    if (worst === null || severityRank(c.severity) > severityRank(worst)) worst = c.severity;
  }
  return worst;
}

/** Worst first, then by code (a stable order for the panel and for change detection). */
export function sortFaultCodes<T extends FaultCode>(codes: readonly T[]): T[] {
  return [...codes].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.code.localeCompare(b.code),
  );
}
