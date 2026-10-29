/**
 * Shared farm vocabulary: the allowed values of farm.* enum-like columns.
 * The database enforces the same lists with CHECK constraints (db/migrations/0001_*),
 * the Drizzle schema types columns with them, and the simulator draws from them.
 * Pure TS, no imports.
 */

export const PARTY_KINDS = ['person', 'org'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const PARTY_ROLES = [
  'owner',
  'crew',
  'landlord',
  'customer',
  'elevator',
  'vendor',
  'neighbor',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const TENURES = ['owned', 'cash_rent', 'share', 'custom'] as const;
export type Tenure = (typeof TENURES)[number];

export const GEOFENCE_KINDS = ['elevator', 'field_entrance', 'shop', 'bin_site', 'fuel'] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];

/** Where a boundary version came from. `deere` boundaries are read-only in the app (D6). */
export const BOUNDARY_SOURCES = ['deere', 'import', 'drawn', 'demo', 'sim'] as const;
export type BoundarySource = (typeof BOUNDARY_SOURCES)[number];

/** Acres per square metre denominator used by the boundary trigger (international acre, rounded as in the plan). */
export const SQ_METRES_PER_ACRE = 4046.86;

/** Display and business time zone. Storage is always timestamptz in UTC. */
export const FARM_TIME_ZONE = 'America/Detroit';

// ---------------------------------------------------------------------------------------------
// M1 vocabulary (db/migrations/0003_m1_see_it.sql enforces the same lists with CHECKs).
// ---------------------------------------------------------------------------------------------

/**
 * App roles, LOWEST FIRST (plan §4 farm.app_users, D8). The order is the permission order:
 * `requireRole('driver')` admits driver, operator, manager and owner. Driver and operator are
 * peers in practice (truck crew vs field crew); the line puts driver first so "crew" checks use
 * `requireRole('driver')`. src/platform/auth/types.ts re-exports these as `ROLES` / `Role`.
 */
export const APP_ROLES = ['viewer', 'driver', 'operator', 'manager', 'owner'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Roles a DEVICE session may carry on its own, before an operator signs in with a PIN
 * (farm.devices.role; a CHECK keeps a device from ever being a manager or owner).
 */
export const DEVICE_ROLES = ['viewer', 'driver', 'operator'] as const satisfies readonly AppRole[];
export type DeviceRole = (typeof DEVICE_ROLES)[number];

/** farm.devices.kind (plan §4). */
export const DEVICE_KINDS = ['wall', 'cab_ipad', 'truck_ipad', 'phone'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/**
 * Shared devices: an operator picks their name and enters a PIN on top of the device session
 * (D8 default: the wall and the cab/truck iPads). Phones are personal: the device belongs to
 * one app user (`farm.devices.app_user_id`) and signs in as that person.
 */
export const SHARED_DEVICE_KINDS = [
  'wall',
  'cab_ipad',
  'truck_ipad',
] as const satisfies readonly DeviceKind[];

/** farm.field_lineage.kind: how a field's identity changed (history survives boundary edits). */
export const LINEAGE_KINDS = ['split', 'merge'] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

/** farm.tile_lines.kind (drawing style and repair meaning). */
export const TILE_LINE_KINDS = ['main', 'submain', 'lateral', 'unknown'] as const;
export type TileLineKind = (typeof TILE_LINE_KINDS)[number];

/** farm.tile_lines.origin: what the line was traced from (plan §4 "source" column). */
export const TILE_LINE_ORIGINS = ['installer_drawing', 'deere_tile_plow', 'manual'] as const;
export type TileLineOrigin = (typeof TILE_LINE_ORIGINS)[number];

/** farm.soil_temp_readings.source: manual probe readings from a phone first (1b), D5 later. */
export const SOIL_TEMP_SOURCES = ['manual', 'station', 'probe'] as const;
export type SoilTempSource = (typeof SOIL_TEMP_SOURCES)[number];
