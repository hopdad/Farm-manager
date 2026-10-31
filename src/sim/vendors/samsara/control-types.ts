/**
 * The Samsara stand-in's fault-code knob (slice 1f, fleet-faults; docs/contracts-1f.md §7.3),
 * served at `${VENDOR_SIM_URL}/_control/vendor/samsara/fault-codes` behind the stand-in's
 * loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/samsara/fault-codes   -> SamsaraSimFaultsStatus
 *   POST /_control/vendor/samsara/fault-codes   SamsaraSimFaultsRequest -> SamsaraSimFaultsStatus
 *
 * POST sets a vehicle's active codes from now on (`codes: []` clears it, the scenario's
 * schedule included), or with `codes: null` hands it back to the scenario's schedule (the
 * `breakdown` scenario gives semi S3 a red-stop-lamp code at 09:40 on day 0). The feed
 * (`/fleet/vehicles/stats/feed?types=faultCodes`) reports the change at the next 5 s grid
 * instant. Kept in the stand-in's state file (`state.vendors['samsara.fault-codes']`); cleared by
 * /_control/reset. This is how the contract tests drive the stub world; a /admin/connectors
 * toggle for it is the integrator's after the merge.
 *
 * Types and zod only (no server code), so the app can import it (the NWS control-types pattern).
 */
import { z } from 'zod';
import { J1939_MAX_FMI, J1939_MAX_SPN, OBD_DTC_STATES } from '../../../domain/fault-codes';
import { SCENARIO_NAMES, type ScenarioName } from '../../types';

/** Path of the knob below VENDOR_SIM_URL. */
export const SAMSARA_SIM_FAULTS_CONTROL_PATH = '/_control/vendor/samsara/fault-codes';

/** Most codes one vehicle can be given. */
export const SAMSARA_SIM_MAX_CODES = 20;

/** J1939 lamps as Samsara's `checkEngineLights` names them (they light the whole reading). */
export const samsaraSimLampsSchema = z.strictObject({
  stop: z.boolean().optional(),
  warning: z.boolean().optional(),
  protect: z.boolean().optional(),
  emissions: z.boolean().optional(),
});

/** One simulated code, in the shape of Samsara's three faultCodes blocks. */
export const samsaraSimFaultSchema = z.discriminatedUnion('system', [
  z.strictObject({
    system: z.literal('j1939'),
    spn: z.number().int().min(0).max(J1939_MAX_SPN),
    fmi: z.number().int().min(0).max(J1939_MAX_FMI),
    /** The controller's source address (default 0, Engine #1). */
    txId: z.number().int().min(0).max(255).optional(),
    occurrenceCount: z.number().int().min(0).max(126).optional(),
    lamps: samsaraSimLampsSchema.optional(),
    description: z.string().max(200).optional(),
  }),
  z.strictObject({
    system: z.literal('obd2'),
    /** SAE J2012, e.g. 'P0087'. */
    dtc: z.string().regex(/^[PCBU][0-3][0-9A-F]{3}$/),
    /** Default 'confirmed'. */
    state: z.enum(OBD_DTC_STATES).optional(),
    /** The module (CAN response id; default 2024 = 0x7E8, the engine controller). */
    txId: z.number().int().min(0).max(0x7ff).optional(),
    /** The module's MIL (default: on for a confirmed or permanent code). */
    mil: z.boolean().optional(),
    description: z.string().max(200).optional(),
  }),
  z.strictObject({
    system: z.literal('oem'),
    code: z.string().min(1).max(40),
    /** Samsara's free-text `codeSeverity` (e.g. 'L03'). */
    severity: z.string().max(40).optional(),
    source: z.string().max(40).optional(),
    description: z.string().max(200).optional(),
  }),
]);
export type SamsaraSimFault = z.infer<typeof samsaraSimFaultSchema>;

export const samsaraSimFaultsRequestSchema = z.strictObject({
  /** The Samsara vehicle id, or its name (the unit number, e.g. 'S3'). */
  vehicle: z.string().min(1).max(64),
  /** The active codes from now on ([] = none); null = back to the scenario's schedule. */
  codes: z.array(samsaraSimFaultSchema).max(SAMSARA_SIM_MAX_CODES).nullable(),
});
export type SamsaraSimFaultsRequest = z.infer<typeof samsaraSimFaultsRequestSchema>;

/** One knob change of one vehicle (wall time). */
export const samsaraSimFaultChangeSchema = z.object({
  setAt: z.iso.datetime({ offset: true }),
  codes: z.array(samsaraSimFaultSchema).nullable(),
});
export type SamsaraSimFaultChange = z.infer<typeof samsaraSimFaultChangeSchema>;

/**
 * What the stand-in keeps: each vehicle's recent knob changes, oldest first (the feed needs the
 * history to report a change, the schedule's return included, at the right instant).
 */
export const samsaraSimFaultsStateSchema = z.object({
  vehicles: z.record(z.string(), z.array(samsaraSimFaultChangeSchema)),
});
export type SamsaraSimFaultsState = z.infer<typeof samsaraSimFaultsStateSchema>;

export const EMPTY_SAMSARA_SIM_FAULTS: SamsaraSimFaultsState = Object.freeze({ vehicles: {} });

/** Where a vehicle's codes come from right now. */
export const SAMSARA_SIM_FAULT_SOURCES = ['knob', 'schedule', 'none'] as const;

export interface SamsaraSimFaultsStatus {
  scenario: ScenarioName;
  simNow: string;
  vehicles: {
    id: string;
    name: string;
    codes: SamsaraSimFault[];
    from: (typeof SAMSARA_SIM_FAULT_SOURCES)[number];
    /** Wall time of the knob change in force, or null. */
    setAt: string | null;
  }[];
  /** The scenario's scheduled code, if it has one (breakdown: S3 at 09:40). */
  schedule: { vehicle: string; simAt: string; codes: SamsaraSimFault[] } | null;
}

export const samsaraSimFaultsStatusSchema = z.object({
  scenario: z.enum(SCENARIO_NAMES),
  simNow: z.iso.datetime({ offset: true }),
  vehicles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      codes: z.array(samsaraSimFaultSchema),
      from: z.enum(SAMSARA_SIM_FAULT_SOURCES),
      setAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
  schedule: z
    .object({
      vehicle: z.string(),
      simAt: z.iso.datetime({ offset: true }),
      codes: z.array(samsaraSimFaultSchema),
    })
    .nullable(),
}) satisfies z.ZodType<SamsaraSimFaultsStatus>;

/** A red-stop-lamp engine code (SPN 110 FMI 0: coolant temperature, most severe): critical. */
export const SIM_RED_STOP_FAULT: SamsaraSimFault = Object.freeze({
  system: 'j1939',
  spn: 110,
  fmi: 0,
  txId: 0,
  occurrenceCount: 1,
  lamps: { stop: true, warning: true },
}) as SamsaraSimFault;
