/**
 * Who may see parcel owners (task 1d, D8): pure, so the server (routes, queries) and the Parcels
 * tab (a hint only) share one rule. Owner names and mailing addresses are for managers and
 * owners; every other signed-in role sees the parcel shapes, numbers and acres only.
 */
import type { ParcelSummary } from '../../domain/parcels';
import { type Role, roleAtLeast } from '../../platform/auth/types';

/** Owner names and mailing addresses are for managers and owners only. */
export const PARCEL_OWNERS_MIN_ROLE: Role = 'manager';

/** May this role see parcel owners? */
export function canSeeParcelOwners(role: Role): boolean {
  return roleAtLeast(role, PARCEL_OWNERS_MIN_ROLE);
}

/**
 * The same rows with owner names and mailing addresses removed for roles below
 * PARCEL_OWNERS_MIN_ROLE (new objects; the input is not changed). Apply it on the server before
 * a response leaves (e.g. GET /api/fields/<id>: `detail.parcels = redactParcelOwners(...)`).
 */
export function redactParcelOwners<T extends Pick<ParcelSummary, 'ownerName' | 'ownerMailing'>>(
  rows: readonly T[],
  role: Role,
): T[] {
  if (canSeeParcelOwners(role)) return rows.map((r) => ({ ...r }));
  return rows.map((r) => ({ ...r, ownerName: null, ownerMailing: null }));
}
