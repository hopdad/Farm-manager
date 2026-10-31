/**
 * Samsara equipment feeds (asset gateways: AG24/AG26/AG46P/AG52 on machines with no OEM API; the
 * demo's RoGator SP2), shared by the client (./equipment-client.ts) and the stand-in module
 * (src/sim/vendors/samsara/equipment-routes.ts). Source: Samsara's OpenAPI
 * (https://developers.samsara.com/openapi/samsara-api.json), operations getEquipmentLocationsFeed
 * and getEquipmentStatsFeed, read Oct 30, 2026 (vendor-docs samsara.md §4):
 *
 *   GET /fleet/equipment/locations/feed?after=&equipmentIds=
 *       { data: [{ id, name, locations: [{ time, latitude, longitude, heading, speed (mph) }] }],
 *         pagination: { endCursor, hasNextPage } }                         5 req/s
 *   GET /fleet/equipment/stats/feed?types=a,b,c,d&after=                   AT MOST 4 types; 10 req/s
 *       { data: [{ id, name, <type>: [{ time, value }] }], pagination }
 *
 * Stat types the app reads: `obdEngineSeconds` (the ECU's own count: raw), `gatewayEngineSeconds`
 * (synthetic: gateway power time plus a manual offset), `gatewayJ1939EngineSeconds` (the J1939
 * cable's count plus a manual offset), `obdEngineStates` (Off/On/Idle), `gatewayEngineStates`
 * (Off/On), `gpsOdometerMeters` (GPS since activation plus a manual offset), `fuelPercents`. The
 * equipment feed has no DEF, no ECU odometer and no fault field. A cursor belongs to its `types`
 * set ("continue to use any additional parameters you had passed"), so each call keeps its own.
 * Rows are read one by one: a row that fails is dropped (logged), never the page.
 */
import { z } from 'zod';
import { samsaraPaginationSchema } from './schemas';

const time = z.iso.datetime({ offset: true });

export const samsaraEquipmentLocationSchema = z.looseObject({
  time,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Degrees. */
  heading: z.number().optional(),
  /** Miles per hour. */
  speed: z.number().optional(),
});
export type SamsaraEquipmentLocation = z.infer<typeof samsaraEquipmentLocationSchema>;

export const samsaraEquipmentLocationsRowSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  locations: z.array(samsaraEquipmentLocationSchema),
});

/** A feed page: rows read one by one (`data` items are checked by the client). */
export const samsaraEquipmentFeedSchema = z.looseObject({
  data: z.array(z.unknown()),
  pagination: samsaraPaginationSchema,
});
export type SamsaraEquipmentFeed = z.infer<typeof samsaraEquipmentFeedSchema>;

/** Every `types` value getEquipmentStatsFeed accepts (the spec's enum). */
export const SAMSARA_EQUIPMENT_STAT_TYPES = [
  'gps',
  'fuelPercents',
  'engineRpm',
  'obdEngineSeconds',
  'gatewayEngineSeconds',
  'gatewayJ1939EngineSeconds',
  'obdEngineStates',
  'gatewayEngineStates',
  'gpsOdometerMeters',
  'engineTotalIdleTimeMinutes',
] as const;
export type SamsaraEquipmentStatType = (typeof SAMSARA_EQUIPMENT_STAT_TYPES)[number];

/** The equipment stats feed takes at most this many `types` per call. */
export const SAMSARA_EQUIPMENT_MAX_TYPES = 4;

/**
 * The app's two stats calls (each ≤ 4 types, each with its own cursor): engine hours in their
 * three flavours and fuel; the engine states and the GPS odometer.
 */
export const EQUIPMENT_STAT_GROUPS = {
  hours: ['obdEngineSeconds', 'gatewayEngineSeconds', 'gatewayJ1939EngineSeconds', 'fuelPercents'],
  state: ['obdEngineStates', 'gatewayEngineStates', 'gpsOdometerMeters'],
} as const satisfies Record<string, readonly SamsaraEquipmentStatType[]>;
export type EquipmentStatGroup = keyof typeof EQUIPMENT_STAT_GROUPS;
export const EQUIPMENT_STAT_GROUP_NAMES = Object.keys(
  EQUIPMENT_STAT_GROUPS,
) as EquipmentStatGroup[];

export const samsaraEquipmentValueSchema = z.looseObject({ time, value: z.number() });
/** `Off` | `On` | `Idle` (read leniently: an unknown state is dropped by the mapper). */
export const samsaraEquipmentStateSchema = z.looseObject({ time, value: z.string() });

const values = z.array(samsaraEquipmentValueSchema).optional();
const states = z.array(samsaraEquipmentStateSchema).optional();

/** One row of the stats feed, the types the app reads. */
export const samsaraEquipmentStatsRowSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  obdEngineSeconds: values,
  gatewayEngineSeconds: values,
  gatewayJ1939EngineSeconds: values,
  fuelPercents: values,
  gpsOdometerMeters: values,
  obdEngineStates: states,
  gatewayEngineStates: states,
});
export type SamsaraEquipmentStatsRow = z.infer<typeof samsaraEquipmentStatsRowSchema>;

/** One location event of one machine (what equipment_positions lands). */
export const samsaraEquipmentPositionRawSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  location: samsaraEquipmentLocationSchema,
});
export type SamsaraEquipmentPositionRaw = z.infer<typeof samsaraEquipmentPositionRawSchema>;

/** One machine's events of one stats call (what equipment_stats lands). */
export const samsaraEquipmentStatRawSchema = z.object({
  group: z.enum(['hours', 'state']),
  row: samsaraEquipmentStatsRowSchema,
});
export type SamsaraEquipmentStatRaw = z.infer<typeof samsaraEquipmentStatRawSchema>;
