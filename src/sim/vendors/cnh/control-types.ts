/**
 * The CNH FieldOps stand-in's knobs (types only, the NWS pattern), at /_control/vendor/cnh/…:
 *
 *   GET  /settings  → CnhSimSettings
 *   POST /settings  { eulaMissing?, locationsEmpty?, wrongKey? }
 *       eulaMissing     VINs (or unit numbers) without an accepted EULA: their telemetry answers
 *                       403 "EULA not accepted for the VIN. Login to FieldOps to accept EULA."
 *                       (vehicle info still answers; the Fleet page leaves them out)
 *       locationsEmpty  VINs whose Locations series is empty (the machine's last-known Location
 *                       then comes from the Fleet snapshot only)
 *       wrongKey        every subscription key is refused (a staging key against production):
 *                       APIM's 401 with WWW-Authenticate: AzureApiManagementKey
 *   GET  /codes     → { cautions, faults }
 *   POST /codes     { action: 'caution', machine, code, description?, severity?, active? }
 *                   { action: 'fault', machine, code, description?, severity? }
 *                   { action: 'clear' }
 *       a caution code (Active true/false) or a fault occurrence at now (wall), served by the
 *       CautionCodes / Faults series
 * Kept in the stand-in's per-vendor bag (`state.vendors.cnh`), so a reset clears it.
 */
import { z } from 'zod';

export const CNH_SIM_SETTINGS_PATH = '/_control/vendor/cnh/settings';
export const CNH_SIM_CODES_PATH = '/_control/vendor/cnh/codes';

export interface CnhSimSettings {
  eulaMissing: string[];
  locationsEmpty: string[];
  wrongKey: boolean;
}

export const cnhSimSettingsRequestSchema = z.strictObject({
  eulaMissing: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  locationsEmpty: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  wrongKey: z.boolean().optional(),
});
export type CnhSimSettingsRequest = z.infer<typeof cnhSimSettingsRequestSchema>;

export interface CnhSimCaution {
  vin: string;
  datetime: string;
  Identifier: string;
  Description?: string;
  Severity?: string;
  Active: boolean;
}

export interface CnhSimFault {
  vin: string;
  datetime: string;
  CodeIdentifier: string;
  CodeDescription?: string;
  CodeSeverity?: string;
}

const common = {
  machine: z.string().trim().min(1).max(40),
  code: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).optional(),
  severity: z.string().trim().max(40).optional(),
};

export const cnhSimCodesRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('caution'), ...common, active: z.boolean().default(true) }),
  z.strictObject({ action: z.literal('fault'), ...common }),
  z.strictObject({ action: z.literal('clear') }),
]);
export type CnhSimCodesRequest = z.infer<typeof cnhSimCodesRequestSchema>;
