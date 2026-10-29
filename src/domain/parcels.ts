/**
 * Parcels contract (plan 1d, D7; docs/contracts-m1.md §5). gis.parcels holds owner names: it is
 * PRIVATE data, served only through the private parcels MVT and session-checked routes.
 * `pnpm gis:parcels <file>` (imagery builder) loads a county or vendor file, or the synthetic
 * fixture until one arrives. Pure TS.
 */
import { deterministicId } from './ids';

/** County FIPS codes of the farm's area (Michigan). */
export const COUNTY_FIPS = {
  lenawee: '26091',
  monroe: '26115',
} as const;

/** One parcel as the UI shows it. */
export interface ParcelSummary {
  id: string;
  countyFips: string;
  parcelNo: string;
  ownerName: string | null;
  ownerMailing: string | null;
  propertyAddress: string | null;
  /** Acres the file states (null when it has none). */
  acres: number | null;
  /** Geodesic area of the geometry. */
  gisAcres: number;
  /** gis.parcel_imports.source of the import that last wrote it ('synthetic' = demo data). */
  importSource: string;
  receivedOn: string | null;
}

/** A parcel overlapping a field (FieldDetail.parcels), largest overlap first. */
export interface FieldParcelRow extends ParcelSummary {
  /** Geodesic acres of field ∩ parcel. */
  overlapAcres: number;
  /** overlapAcres as a percent of the field's current boundary. */
  overlapPct: number;
}

/** Properties of a feature in the `parcels` vector tile layer (app.mvt_parcels). */
export interface ParcelTileProperties {
  id: string;
  county_fips: string;
  parcel_no: string;
  owner_name?: string;
  owner_mailing?: string;
  /** The file's acres, else the geodesic area; 1 decimal. */
  acres: number;
}

/**
 * Stable parcel id: uuid v5 of `parcel:<county>:<parcel number>` (normalized), so a re-import or
 * a newer file for the same county keeps ids, and rows that point at parcels (CDL/terrain stats
 * in 1e, prospect notes in M4) survive. Importers use it for gis.parcels.id.
 */
export function parcelId(countyFips: string, parcelNo: string): string {
  if (!/^\d{5}$/.test(countyFips)) throw new Error(`bad county FIPS '${countyFips}'`);
  const norm = normalizeParcelNo(parcelNo);
  if (!norm) throw new Error('empty parcel number');
  return deterministicId('parcel', `${countyFips}:${norm}`);
}

/** Parcel numbers as counties print them vary in case and spacing: trim, upper-case, collapse spaces. */
export function normalizeParcelNo(parcelNo: string): string {
  return parcelNo.trim().toUpperCase().replace(/\s+/g, ' ');
}
