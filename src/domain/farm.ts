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
