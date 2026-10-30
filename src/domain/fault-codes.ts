/**
 * Vehicle and machine fault codes (slice 1f; one vendor-neutral model since 1f.2). Not to be
 * confused with the stand-in's "faults" (vendor API fault injection, src/sim/vendors/faults.ts):
 * these are the codes a truck's or machine's controllers report through its telematics feed.
 *
 * ONE MODEL, THREE CODE SYSTEMS (docs/contracts-1f.md §5.3 and part B):
 *  - `j1939`: SAE J1939 DM1 codes, SPN + FMI (+ the source address and occurrence count when the
 *    vendor sends them), with the controller's lamp states (red stop, amber warning, protect,
 *    malfunction/emissions). Samsara `faultCodes.j1939`, Motive, Geotab (Diagnostic lookup),
 *    Terminal, AEMP fault time series, Deere/CNH machines.
 *  - `obd2`: SAE J2012 / ISO 15031-6 DTCs ('P0217'), confirmed, pending or permanent, with the MIL.
 *    Samsara `faultCodes.obdii`, Geotab (after the hex conversion), carmaker clouds.
 *  - `oem`: a manufacturer's own caution or fault codes (CNH FieldOps Caution Codes / Fault Codes,
 *    Deere alerts) with the vendor's own severity label.
 *
 * Every fault carries a severity (decision 1f-2, extended per system by `faultSeverity`), an
 * open/closed state and first/last seen times. Two ways a vendor reports them
 * (`NormalizedVehicleStat.faultReport`, src/connectors/types.ts):
 *  - `snapshot` (Samsara's faultCodes stat): the list is the machine's complete ACTIVE set at `ts`;
 *    a code the list no longer names has cleared; `[]` = cleared; absent = says nothing.
 *  - `delta` (Motive /v1/fault_codes, Geotab FaultData, AEMP fault time series, Terminal fault
 *    events): each item states its own `state` (open/closed) and times; codes not named are
 *    unchanged.
 *
 * Storage: `farm.machine_faults` keeps the history (one open row per machine, source and code,
 * with the system columns of migration 0007); `farm.machine_state.fault_codes` the current
 * summary (`ActiveFaultCode[]`, worst first), guarded by `faults_at`. A critical fault never
 * marks a machine down by itself: it OFFERS "Critical fault: mark down?" to a driver and above.
 *
 * Pure TS + zod. Owned by the 1f foundation (contract file).
 */
import { z } from 'zod';

/** Lowest first. */
export const FAULT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type FaultSeverity = (typeof FAULT_SEVERITIES)[number];

/** The code system a fault belongs to (machine_faults.system). */
export const FAULT_SYSTEMS = ['j1939', 'obd2', 'oem'] as const;
export type FaultSystem = (typeof FAULT_SYSTEMS)[number];

/** OBD-II DTC status (machine_faults.dtc_state; obd2 only). */
export const OBD_DTC_STATES = ['confirmed', 'pending', 'permanent'] as const;
export type ObdDtcState = (typeof OBD_DTC_STATES)[number];

/** An OEM code's class (machine_faults.oem_class; oem only): CNH caution codes vs fault codes. */
export const OEM_FAULT_CLASSES = ['caution', 'fault'] as const;
export type OemFaultClass = (typeof OEM_FAULT_CLASSES)[number];

/** Open = active now; closed = the vendor says it cleared (machine_faults.cleared_at set). */
export const FAULT_STATES = ['open', 'closed'] as const;
export type FaultState = (typeof FAULT_STATES)[number];

/** J1939 SPN is 19 bits, FMI 5 bits (the CHECKs of machine_faults use the same bounds). */
export const J1939_MAX_SPN = 524_287;
export const J1939_MAX_FMI = 31;

/**
 * Lamp states as the vendor reports them (machine_faults.lamps; null/absent = not reported).
 * J1939: `redStop`, `amberWarning`, `protect`, `malfunction` (the emissions/MIL lamp). OBD-II:
 * `malfunction` is the MIL.
 */
export interface FaultLamps {
  redStop?: boolean | null;
  amberWarning?: boolean | null;
  protect?: boolean | null;
  malfunction?: boolean | null;
}

export const faultLampsSchema = z.object({
  redStop: z.boolean().nullable().optional(),
  amberWarning: z.boolean().nullable().optional(),
  protect: z.boolean().nullable().optional(),
  malfunction: z.boolean().nullable().optional(),
}) satisfies z.ZodType<FaultLamps>;

/** The system-specific identity of a fault (what `faultCodeKey` builds the history key from). */
export interface FaultIdentity {
  system: FaultSystem;
  /** j1939 */
  spn?: number | null;
  fmi?: number | null;
  /** j1939: the controller's source address, when the vendor sends it (not part of the key). */
  sourceAddress?: number | null;
  /** obd2: the DTC as printed ('P0217'; hex forms are converted by the mapper). */
  dtc?: string | null;
  /** oem: the manufacturer's code as printed. */
  oemCode?: string | null;
  oemClass?: OemFaultClass | null;
}

/**
 * One active code (the panel and machine_state.fault_codes). The 1f fields (`code`, `severity`,
 * `description`) are required; the system fields are optional, so a 1f row stays valid.
 */
export interface FaultCode {
  /** The history key: `faultCodeKey(identity)` ('J1939 SPN 110 FMI 0', 'P0217', 'OEM caution 1234'). */
  code: string;
  severity: FaultSeverity;
  description: string | null;
  system?: FaultSystem;
  spn?: number | null;
  fmi?: number | null;
  dtcState?: ObdDtcState | null;
  oemClass?: OemFaultClass | null;
  lamps?: FaultLamps | null;
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
  system: z.enum(FAULT_SYSTEMS).optional(),
  spn: z.number().int().min(0).max(J1939_MAX_SPN).nullable().optional(),
  fmi: z.number().int().min(0).max(J1939_MAX_FMI).nullable().optional(),
  dtcState: z.enum(OBD_DTC_STATES).nullable().optional(),
  oemClass: z.enum(OEM_FAULT_CLASSES).nullable().optional(),
  lamps: faultLampsSchema.nullable().optional(),
}) satisfies z.ZodType<FaultCode>;

export const activeFaultCodeSchema = faultCodeSchema.extend({
  since: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<ActiveFaultCode>;

/**
 * One fault as a connector reports it (NormalizedVehicleStat.faultCodes; src/connectors/types.ts).
 * The mapper fills the system fields it has, the severity from `faultSeverity` (or the vendor's
 * own label mapped by `oemSeverity`), and the state and times when the vendor sends them.
 */
export interface NormalizedFault extends FaultIdentity {
  /** `faultCodeKey(this)`: the history key (machine_faults.code). */
  code: string;
  severity: FaultSeverity;
  description?: string | null;
  /** j1939: how many times the controller counted it, when sent. */
  occurrenceCount?: number | null;
  /** obd2 */
  dtcState?: ObdDtcState | null;
  lamps?: FaultLamps | null;
  /** The vendor's own severity or priority label, verbatim (shown on hover; not the policy). */
  vendorSeverity?: string | null;
  /** Default `open`. In a `snapshot` report every item is open. */
  state?: FaultState;
  /** Vendor times (UTC ISO), when the vendor sends them; else the event's `ts` is used. */
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  closedAt?: string | null;
}

const isoOpt = z.iso.datetime({ offset: true }).nullable().optional();

export const normalizedFaultSchema = z
  .object({
    system: z.enum(FAULT_SYSTEMS),
    code: z.string().min(1),
    severity: z.enum(FAULT_SEVERITIES),
    description: z.string().nullable().optional(),
    spn: z.number().int().min(0).max(J1939_MAX_SPN).nullable().optional(),
    fmi: z.number().int().min(0).max(J1939_MAX_FMI).nullable().optional(),
    sourceAddress: z.number().int().min(0).max(255).nullable().optional(),
    occurrenceCount: z.number().int().min(0).nullable().optional(),
    dtc: z.string().min(1).nullable().optional(),
    dtcState: z.enum(OBD_DTC_STATES).nullable().optional(),
    oemCode: z.string().min(1).nullable().optional(),
    oemClass: z.enum(OEM_FAULT_CLASSES).nullable().optional(),
    lamps: faultLampsSchema.nullable().optional(),
    vendorSeverity: z.string().nullable().optional(),
    state: z.enum(FAULT_STATES).optional(),
    firstSeenAt: isoOpt,
    lastSeenAt: isoOpt,
    closedAt: isoOpt,
  })
  .superRefine((f, ctx) => {
    if (f.system === 'j1939' && (f.spn == null || f.fmi == null)) {
      ctx.addIssue({ code: 'custom', message: 'a j1939 fault needs spn and fmi' });
    }
    if (f.system === 'obd2' && !f.dtc) {
      ctx.addIssue({ code: 'custom', message: 'an obd2 fault needs its dtc' });
    }
    if (f.system === 'oem' && !f.oemCode) {
      ctx.addIssue({ code: 'custom', message: 'an oem fault needs its oemCode' });
    }
    if (f.code !== faultCodeKey(f)) {
      ctx.addIssue({
        code: 'custom',
        message: `code must be faultCodeKey(): '${faultCodeKey(f)}'`,
      });
    }
  }) satisfies z.ZodType<NormalizedFault>;

/**
 * The stable history key of a fault (machine_faults.code; unique per machine and source while
 * open): `J1939 SPN <spn> FMI <fmi>`, the OBD DTC upper-cased (`P0217`), `OEM <class> <code>`
 * (or `OEM <code>` without a class). The source address isn't part of it (vendors don't all
 * send it), so the same SPN/FMI from two controllers is one fault.
 */
export function faultCodeKey(f: FaultIdentity): string {
  switch (f.system) {
    case 'j1939':
      return `J1939 SPN ${f.spn ?? '?'} FMI ${f.fmi ?? '?'}`;
    case 'obd2':
      return (f.dtc ?? '?').trim().toUpperCase();
    case 'oem':
      return f.oemClass ? `OEM ${f.oemClass} ${f.oemCode ?? '?'}` : `OEM ${f.oemCode ?? '?'}`;
  }
}

/**
 * An OEM's own severity label → ours: 'critical' / 'high' / 'stop' / 'red' / 'severe' →
 * critical; 'medium' / 'warning' / 'amber' / 'yellow' / 'caution' → warning; 'low' / 'info' /
 * 'informational' / 'none' → info. Case-insensitive; unknown labels → null (the class decides).
 */
export function oemSeverity(label: string | null | undefined): FaultSeverity | null {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return null;
  if (/^(critical|high|stop|red|severe|shutdown|urgent)\b/.test(l)) return 'critical';
  if (/^(medium|med|warning|warn|amber|yellow|caution|moderate)\b/.test(l)) return 'warning';
  if (/^(low|info|informational|information|none|notice)\b/.test(l)) return 'info';
  return null;
}

/** What `faultSeverity` decides on. */
export interface FaultSeverityInput {
  system: FaultSystem;
  lamps?: FaultLamps | null;
  dtcState?: ObdDtcState | null;
  oemClass?: OemFaultClass | null;
  vendorSeverity?: string | null;
}

/**
 * Decision 1f-2, extended per system (docs/decisions.md 1f-2):
 *  - j1939: critical = red stop lamp; warning = amber warning, protect or malfunction lamp;
 *    info = an active code with no lamp on (or lamps not reported).
 *  - obd2: warning = MIL on, or a confirmed or permanent DTC; info = pending. (OBD-II has no
 *    stop lamp: never critical.)
 *  - oem: the vendor's own label when `oemSeverity` knows it, else fault → warning,
 *    caution → info (no class → warning).
 */
export function faultSeverity(f: FaultSeverityInput): FaultSeverity {
  const lamps = f.lamps ?? {};
  switch (f.system) {
    case 'j1939':
      if (lamps.redStop) return 'critical';
      if (lamps.amberWarning || lamps.protect || lamps.malfunction) return 'warning';
      return 'info';
    case 'obd2':
      if (lamps.malfunction || f.dtcState === 'confirmed' || f.dtcState === 'permanent') {
        return 'warning';
      }
      return 'info';
    case 'oem':
      return oemSeverity(f.vendorSeverity) ?? (f.oemClass === 'caution' ? 'info' : 'warning');
  }
}

/** A NormalizedFault from its identity and details: the key and the severity filled in. */
export function normalizedFault(
  f: Omit<NormalizedFault, 'code' | 'severity'> & { severity?: FaultSeverity },
): NormalizedFault {
  return { ...f, code: faultCodeKey(f), severity: f.severity ?? faultSeverity(f) };
}

/** The panel's view of a fault (drops the history-only fields). */
export function toFaultCode(f: NormalizedFault): FaultCode {
  return {
    code: f.code,
    severity: f.severity,
    description: f.description ?? null,
    system: f.system,
    ...(f.system === 'j1939' ? { spn: f.spn ?? null, fmi: f.fmi ?? null } : {}),
    ...(f.system === 'obd2' ? { dtcState: f.dtcState ?? null } : {}),
    ...(f.system === 'oem' ? { oemClass: f.oemClass ?? null } : {}),
    ...(f.lamps ? { lamps: f.lamps } : {}),
  };
}

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
