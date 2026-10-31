/**
 * The Motive stand-in's control API (slice 1f.2, the trucks builder; docs/contracts-1f.md §B.7),
 * served at `${VENDOR_SIM_URL}/_control/vendor/motive/…` behind the stand-in's
 * loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/motive/fault-codes   -> MotiveSimStatus
 *   POST /_control/vendor/motive/fault-codes   MotiveSimFaultRequest -> MotiveSimStatus
 *        { action: 'open', vehicleId?, kind? }  a new open fault (J1939 SPN 110 FMI 0, OBD-II
 *                                               P0217 or an OEM code) on a Motive vehicle (the
 *                                               first one when left out); Motive keeps moving its
 *                                               last_observed_at (whole minutes) while it is open
 *        { action: 'close', id }                closed now (status `closed`)
 *        { action: 'clear' }                    no fault records at all
 *   GET  /_control/vendor/motive/gateway       -> MotiveSimStatus
 *   POST /_control/vendor/motive/gateway       { vehicleId, gateway: true | false | null }
 *        overrides whether a vehicle has a Motive Vehicle Gateway (v3 lists only those); null
 *        goes back to the world's (`SimTelematics.gateway`)
 *
 * Kept in the stand-in's state file (`state.vendors.motive`); cleared by /_control/reset.
 * Types and zod only (no server code), like the NWS stand-in's control types.
 */
import { z } from 'zod';

/** The simulated hauler's Motive company (`GET /v1/companies` → `company.id`; the sourceOrg). */
export const SIM_MOTIVE_COMPANY_ID = '731204';
/** Its human-readable company id (Motive's `company_id`, e.g. "KT1607533"). */
export const SIM_MOTIVE_COMPANY_CODE = 'KTSIM73120';

export const MOTIVE_SIM_FAULT_CODES_PATH = '/_control/vendor/motive/fault-codes';
export const MOTIVE_SIM_GATEWAY_PATH = '/_control/vendor/motive/gateway';

/** The code systems the knob can raise (Motive's own examples: obdii, SPN-n + FMI, OEM codes). */
export const MOTIVE_SIM_FAULT_KINDS = ['j1939', 'obd2', 'oem'] as const;
export type MotiveSimFaultKind = (typeof MOTIVE_SIM_FAULT_KINDS)[number];

const iso = z.iso.datetime({ offset: true });

export const motiveSimFaultSchema = z.object({
  /** Motive's fault record id (an integer, as a string). */
  id: z.string().min(1),
  vehicleId: z.string().min(1),
  kind: z.enum(MOTIVE_SIM_FAULT_KINDS),
  /** Wall time it opened (first_observed_at). */
  openedAt: iso,
  /** Wall time it closed, or null while open. */
  closedAt: iso.nullable(),
});
export type MotiveSimFault = z.infer<typeof motiveSimFaultSchema>;

/** `state.vendors.motive`. */
export const motiveSimStateSchema = z.object({
  faults: z.array(motiveSimFaultSchema),
  nextFaultId: z.number().int().positive(),
  gateway: z.record(z.string(), z.boolean()),
});
export type MotiveSimState = z.infer<typeof motiveSimStateSchema>;

export const EMPTY_MOTIVE_SIM_STATE: MotiveSimState = Object.freeze({
  faults: [],
  nextFaultId: 51_000,
  gateway: {},
}) as MotiveSimState;

export const motiveSimFaultRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    vehicleId: z.string().min(1).optional(),
    kind: z.enum(MOTIVE_SIM_FAULT_KINDS).optional(),
  }),
  z.strictObject({ action: z.literal('close'), id: z.string().min(1) }),
  z.strictObject({ action: z.literal('clear') }),
]);
export type MotiveSimFaultRequest = z.infer<typeof motiveSimFaultRequestSchema>;

export const motiveSimGatewayRequestSchema = z.strictObject({
  vehicleId: z.string().min(1),
  gateway: z.boolean().nullable(),
});
export type MotiveSimGatewayRequest = z.infer<typeof motiveSimGatewayRequestSchema>;

/** What both knobs answer. */
export interface MotiveSimStatus {
  companyId: string;
  vehicles: { id: string; unitNo: string; gateway: boolean }[];
  faults: MotiveSimFault[];
}
