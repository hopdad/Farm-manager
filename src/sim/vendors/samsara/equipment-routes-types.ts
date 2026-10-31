/**
 * The Samsara equipment-feed stand-in's knobs (types only, the NWS pattern), served at
 * /_control/vendor/samsara/equipment/settings (GET: the current settings; POST: change some):
 *
 *   hoursFrom  which engine-hours stats the gateway sends: 'obd' (obdEngineSeconds, the ECU),
 *              'gateway' (gatewayEngineSeconds, synthetic), 'j1939' (gatewayJ1939EngineSeconds,
 *              the J1939 count plus a manual offset). Default ['obd', 'gateway'] (the client
 *              prefers obd); [] = no engine hours at all.
 *   silent     the gateway stopped reporting: both feeds answer no data (cursors still move), so
 *              the machine's live fix goes stale and a last-known snapshot (Samsara's AEMP feed)
 *              may take over.
 * Kept in the stand-in's per-module bag (`samsaraModuleState(ctx, 'equipment')`); reset clears it.
 */
import { z } from 'zod';

export const SAMSARA_EQUIPMENT_SETTINGS_PATH = '/_control/vendor/samsara/equipment/settings';

export const EQUIPMENT_HOURS_SOURCES = ['obd', 'gateway', 'j1939'] as const;
export type EquipmentHoursSource = (typeof EQUIPMENT_HOURS_SOURCES)[number];

export interface SamsaraEquipmentSettings {
  hoursFrom: EquipmentHoursSource[];
  silent: boolean;
}

export const DEFAULT_EQUIPMENT_SETTINGS: SamsaraEquipmentSettings = Object.freeze({
  hoursFrom: ['obd', 'gateway'],
  silent: false,
}) as SamsaraEquipmentSettings;

export const samsaraEquipmentSettingsRequestSchema = z.strictObject({
  hoursFrom: z.array(z.enum(EQUIPMENT_HOURS_SOURCES)).max(3).optional(),
  silent: z.boolean().optional(),
});
export type SamsaraEquipmentSettingsRequest = z.infer<typeof samsaraEquipmentSettingsRequestSchema>;
