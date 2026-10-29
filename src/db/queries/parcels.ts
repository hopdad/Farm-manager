/**
 * Parcels (plan 1d, D7; docs/contracts-m1.md §3.1, §5.3). gis.parcels holds owner names and
 * mailing addresses: PRIVATE data. Who sees what (task 1d, D8):
 *
 *  - every signed-in viewer: the parcel shapes, numbers and acres (tiles, the Parcels tab);
 *  - managers and owners (PARCEL_OWNERS_MIN_ROLE): also owner names and mailing addresses.
 *
 * The decision is made on the server: `redactParcelOwners` for JSON (the field panel's
 * FieldDetail.parcels), `parcelTileSql(withOwners)` for the private parcels MVT
 * (`app.mvt_parcels(z, x, y, with_owners)`, db/pending/imagery.sql). The Parcels tab hides the
 * owner columns below the role too, but that is only a hint.
 *
 * Writers (`pnpm gis:parcels`, tools/gis/parcels-load.ts) bump `updated_at` so the tiles'
 * version changes, and publish `layers`/`updated { key: 'parcels' }`.
 */
import type { FieldParcelRow, ParcelSummary } from '../../domain/parcels';
import type { Role } from '../../platform/auth/types';
import type { Queryable } from '../client';
import { redactParcelOwners } from './parcels-access';

export { canSeeParcelOwners, PARCEL_OWNERS_MIN_ROLE, redactParcelOwners } from './parcels-access';

/**
 * SQL for the parcels tile with or without owners ($1 z, $2 x, $3 y), for the tiles route's
 * layer registry. With owners for `canSeeParcelOwners(session.role)`.
 */
export function parcelTileSql(withOwners: boolean): string {
  return `select app.mvt_parcels($1, $2, $3, ${withOwners ? 'true' : 'false'}) as mvt`;
}

/**
 * Suffix for the tile URL's version so the two variants never share a cache entry (the tiles are
 * `private, immutable` for a year: a shared wall browser must not keep a manager's owner tiles
 * for the next viewer).
 */
export function parcelTileVersionSuffix(withOwners: boolean): string {
  return withOwners ? '.o' : '';
}

interface ParcelRowSql {
  id: string;
  county_fips: string;
  parcel_no: string;
  owner_name: string | null;
  owner_mailing: string | null;
  property_address: string | null;
  acres: string | null;
  gis_acres: string;
  import_source: string;
  received_on: string | null;
  overlap_acres?: number;
  overlap_pct?: number;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toSummary(r: ParcelRowSql): ParcelSummary {
  return {
    id: r.id,
    countyFips: r.county_fips,
    parcelNo: r.parcel_no,
    ownerName: r.owner_name,
    ownerMailing: r.owner_mailing,
    propertyAddress: r.property_address,
    acres: num(r.acres),
    gisAcres: Number(r.gis_acres),
    importSource: r.import_source,
    receivedOn: r.received_on,
  };
}

/** Parcels touching a field by less than this many acres (a shared fence line) are left out. */
export const MIN_OVERLAP_ACRES = 0.01;

/**
 * Parcels overlapping a field's current boundary, largest overlap first (geodesic acres). The
 * field panel builds the same list inside its one-statement FieldDetail query; this standalone
 * version serves tools, tests and any caller that needs only the parcels.
 */
export async function fieldParcels(
  ex: Queryable,
  fieldId: string,
  role: Role,
): Promise<FieldParcelRow[]> {
  const r = await ex.query<ParcelRowSql & { overlap_acres: number; overlap_pct: number }>(
    `with bnd as (
       select b.geom, b.acres from farm.current_boundaries b where b.field_id = $1::uuid
     ), x as (
       select p.id::text, p.county_fips, p.parcel_no, p.owner_name, p.owner_mailing,
              p.property_address, p.acres::text, p.gis_acres::text, pi.source as import_source,
              to_char(pi.received_on, 'YYYY-MM-DD') as received_on, bnd.acres as field_acres,
              extensions.ST_Area(extensions.ST_Intersection(
                extensions.ST_MakeValid(p.geom), extensions.ST_MakeValid(bnd.geom)
              )::extensions.geography) / 4046.86 as overlap_acres
         from bnd
         join gis.parcels p on extensions.ST_Intersects(p.geom, bnd.geom)
         join gis.parcel_imports pi on pi.id = p.import_id
     )
     select x.*, round(x.overlap_acres::numeric, 2)::float8 as overlap_acres,
            round((100 * x.overlap_acres / nullif(x.field_acres, 0))::numeric, 1)::float8 as overlap_pct
       from x
      where x.overlap_acres >= $2
      order by x.overlap_acres desc, x.parcel_no`,
    [fieldId, MIN_OVERLAP_ACRES],
  );
  const rows = r.rows.map((row) => ({
    ...toSummary(row),
    overlapAcres: Number(row.overlap_acres),
    overlapPct: Number(row.overlap_pct ?? 0),
  }));
  return redactParcelOwners(rows, role);
}

/** One parcel by id (owners redacted below PARCEL_OWNERS_MIN_ROLE), or null. */
export async function parcelById(
  ex: Queryable,
  id: string,
  role: Role,
): Promise<ParcelSummary | null> {
  const r = await ex.query<ParcelRowSql>(
    `select p.id::text, p.county_fips, p.parcel_no, p.owner_name, p.owner_mailing,
            p.property_address, p.acres::text, p.gis_acres::text, pi.source as import_source,
            to_char(pi.received_on, 'YYYY-MM-DD') as received_on
       from gis.parcels p
       join gis.parcel_imports pi on pi.id = p.import_id
      where p.id = $1::uuid`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return redactParcelOwners([toSummary(row)], role)[0] ?? null;
}
