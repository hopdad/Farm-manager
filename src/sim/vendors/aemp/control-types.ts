/**
 * The AEMP stand-in's knobs (types only, the NWS pattern; served at /_control/vendor/aemp/…):
 *
 *   GET  /_control/vendor/aemp/faults   → { faults: AempSimFault[] }
 *   POST /_control/vendor/aemp/faults   { action: 'add', provider?, machine, code, description?,
 *                                         severity?, at? } adds one FaultCode occurrence (at = wall
 *                                         time, default now) to the provider's fault series;
 *                                         { action: 'clear' } removes them all
 *
 * `machine` is a unit number (`L1`) or the provider's machine id. Only `kubota` serves a fault
 * series (Samsara documents none; Deere neither). State lives in the stand-in's per-vendor bag
 * (`state.vendors.aemp`), so a reset clears it.
 */
import { z } from 'zod';

export const AEMP_SIM_FAULTS_CONTROL_PATH = '/_control/vendor/aemp/faults';

/** Providers whose stand-in serves a fault series (Trackunit's path form). */
export const AEMP_SIM_FAULT_PROVIDERS = ['kubota'] as const;

/** The fault series path the stand-in serves (Trackunit's form, below /aemp/<provider>). */
export const AEMP_SIM_FAULTS_PATH = '/Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}';

export interface AempSimFault {
  provider: string;
  /** The provider's machine id (PIN). */
  machineId: string;
  /** Wall time of the occurrence (UTC ISO). */
  datetime: string;
  CodeIdentifier: string;
  CodeDescription?: string;
  CodeSeverity?: string;
}

export const aempSimFaultRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'),
    provider: z.enum(AEMP_SIM_FAULT_PROVIDERS).default('kubota'),
    machine: z.string().trim().min(1).max(64),
    code: z.string().trim().min(1).max(64),
    description: z.string().trim().max(200).optional(),
    severity: z.string().trim().max(40).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({ action: z.literal('clear') }),
]);
export type AempSimFaultRequest = z.infer<typeof aempSimFaultRequestSchema>;
