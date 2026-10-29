/**
 * Field identity for /admin/fields (plan 1c): the list, creating a field by drawing it, and
 * editing name, farm, tenure, landlord, county and active. Boundary versions live in
 * ./boundaries.ts, splits and merges in ./lineage.ts.
 *
 * D6: a field with a deere_field_id is named and shaped in Operations Center, so the app keeps
 * its name and boundary read-only; tenure, landlord, county and active are the farm's own
 * business and stay editable.
 */
import type { MultiPolygon } from 'geojson';
import type pg from 'pg';
import { TENURES, type Tenure } from '../../domain/farm';
import { boundaryEditPolicy, DEERE_BOUNDARY_READ_ONLY } from '../../domain/fields';
import type { Queryable } from '../client';
import { setDemoFieldsActive, writeBoundaryVersion } from './boundaries';
import {
  type Actor,
  FieldChanges,
  FieldDataError,
  iso,
  NORM_TEXT,
  normText,
  withTransaction,
} from './boundaries-sql';

export interface AdminFieldRow {
  id: string;
  name: string;
  farmId: string;
  farmName: string;
  customerName: string | null;
  tenure: Tenure;
  landlordId: string | null;
  landlordName: string | null;
  countyFips: string | null;
  acres: number | null;
  deereFieldId: string | null;
  active: boolean;
  source: string;
  boundarySource: string | null;
  openRequests: number;
  editable: boolean;
  /** farm.fields.updated_at (optimistic saves). */
  version: string;
}

const FIELD_ROW_SQL = `
  select f.id, f.name, f.farm_id, fa.name as farm_name, cp.display_name as customer_name, f.tenure,
         f.landlord_party_id, lp.display_name as landlord_name, f.county_fips,
         b.acres::float8 as acres, f.deere_field_id, f.active, f.source, b.source as boundary_source,
         (select count(*)::int from farm.boundary_change_requests r
           where r.field_id = f.id and r.resolved_at is null) as open_requests,
         f.updated_at
    from farm.fields f
    join farm.farms fa on fa.id = f.farm_id
    left join farm.parties cp on cp.id = fa.client_party_id
    left join farm.parties lp on lp.id = f.landlord_party_id
    left join farm.current_boundaries b on b.field_id = f.id`;

interface FieldDbRow {
  id: string;
  name: string;
  farm_id: string;
  farm_name: string;
  customer_name: string | null;
  tenure: Tenure;
  landlord_party_id: string | null;
  landlord_name: string | null;
  county_fips: string | null;
  acres: number | null;
  deere_field_id: string | null;
  active: boolean;
  source: string;
  boundary_source: string | null;
  open_requests: number;
  updated_at: Date;
}

const toRow = (x: FieldDbRow): AdminFieldRow => ({
  id: x.id,
  name: x.name,
  farmId: x.farm_id,
  farmName: x.farm_name,
  customerName: x.customer_name,
  tenure: x.tenure,
  landlordId: x.landlord_party_id,
  landlordName: x.landlord_name,
  countyFips: x.county_fips,
  acres: x.acres,
  deereFieldId: x.deere_field_id,
  active: x.active,
  source: x.source,
  boundarySource: x.boundary_source,
  openRequests: x.open_requests,
  editable: boundaryEditPolicy({ deereFieldId: x.deere_field_id }).editable,
  version: iso(x.updated_at) as string,
});

export async function listAdminFields(
  ex: Queryable,
  opts: { includeInactive?: boolean; q?: string } = {},
): Promise<AdminFieldRow[]> {
  const q = opts.q?.trim() ? `%${normText(opts.q)}%` : null;
  const r = await ex.query<FieldDbRow>(
    `${FIELD_ROW_SQL}
      where ($1 or f.active)
        and ($2::text is null or ${NORM_TEXT('f.name')} like $2 or ${NORM_TEXT('fa.name')} like $2)
      order by f.active desc, fa.name, f.name
      limit 2000`,
    [opts.includeInactive ?? false, q],
  );
  return r.rows.map(toRow);
}

export async function getAdminField(ex: Queryable, fieldId: string): Promise<AdminFieldRow | null> {
  const r = await ex.query<FieldDbRow>(`${FIELD_ROW_SQL} where f.id = $1`, [fieldId]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export interface FarmOption {
  id: string;
  name: string;
  clientPartyId: string | null;
  clientName: string | null;
  source: string;
  fieldCount: number;
}

export async function listFarms(ex: Queryable): Promise<FarmOption[]> {
  const r = await ex.query<{
    id: string;
    name: string;
    client_party_id: string | null;
    client_name: string | null;
    source: string;
    field_count: number;
  }>(
    `select fa.id, fa.name, fa.client_party_id, p.display_name as client_name, fa.source,
            (select count(*)::int from farm.fields f where f.farm_id = fa.id and f.active) as field_count
       from farm.farms fa left join farm.parties p on p.id = fa.client_party_id
      order by fa.name`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    clientPartyId: x.client_party_id,
    clientName: x.client_name,
    source: x.source,
    fieldCount: x.field_count,
  }));
}

export interface FieldIdentityInput {
  name: string;
  /** An existing farm, or … */
  farmId: string | null;
  /** … a new one by name (created with source 'app'). */
  newFarmName?: string | null;
  tenure: Tenure;
  landlordPartyId: string | null;
  countyFips: string | null;
}

function checkIdentity(i: FieldIdentityInput): void {
  if (!i.name.trim()) throw new FieldDataError('the field needs a name');
  if (i.name.trim().length > 120)
    throw new FieldDataError('the name is longer than 120 characters');
  if (!(TENURES as readonly string[]).includes(i.tenure))
    throw new FieldDataError('unknown tenure');
  if (i.countyFips && !/^\d{5}$/.test(i.countyFips)) {
    throw new FieldDataError('the county is a 5-digit FIPS code (26091 Lenawee, 26115 Monroe)');
  }
  if (!i.farmId && !i.newFarmName?.trim()) throw new FieldDataError('pick a farm');
}

async function resolveFarm(c: pg.PoolClient, i: FieldIdentityInput): Promise<string> {
  if (i.farmId) {
    const r = await c.query('select 1 from farm.farms where id = $1', [i.farmId]);
    if (!r.rowCount) throw new FieldDataError('that farm no longer exists', 'stale');
    return i.farmId;
  }
  const name = (i.newFarmName ?? '').replace(/\s+/g, ' ').trim();
  const found = await c.query<{ id: string }>(
    `select id from farm.farms where ${NORM_TEXT('name')} = $1 order by created_at limit 1`,
    [normText(name)],
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await c.query<{ id: string }>(
    `insert into farm.farms (name, source) values ($1, 'app') returning id`,
    [name],
  );
  return (ins.rows[0] as { id: string }).id;
}

async function checkLandlord(c: pg.PoolClient, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const r = await c.query('select 1 from farm.parties where id = $1', [partyId]);
  if (!r.rowCount) throw new FieldDataError('that landlord no longer exists', 'stale');
}

async function checkUniqueName(
  c: pg.PoolClient,
  farmId: string,
  name: string,
  except: string | null,
): Promise<void> {
  const r = await c.query<{ name: string }>(
    `select name from farm.fields
      where farm_id = $1 and active and ${NORM_TEXT('name')} = $2 and ($3::uuid is null or id <> $3)`,
    [farmId, normText(name), except],
  );
  if (r.rows[0]) {
    throw new FieldDataError(`this farm already has a field named '${r.rows[0].name}'`, 'conflict');
  }
}

/** A new field drawn on the map (prospects, customers not in Ops Center): source 'app'. */
export async function createDrawnField(
  pool: pg.Pool,
  args: { identity: FieldIdentityInput; geometry: MultiPolygon; actor: Actor },
): Promise<{ fieldId: string; acres: number }> {
  checkIdentity(args.identity);
  return withTransaction(pool, async (c) => {
    const farmId = await resolveFarm(c, args.identity);
    await checkLandlord(c, args.identity.landlordPartyId);
    const name = args.identity.name.replace(/\s+/g, ' ').trim();
    await checkUniqueName(c, farmId, name, null);
    const f = await c.query<{ id: string }>(
      `insert into farm.fields (farm_id, name, tenure, landlord_party_id, county_fips, source)
       values ($1, $2, $3, $4, $5, 'app') returning id`,
      [farmId, name, args.identity.tenure, args.identity.landlordPartyId, args.identity.countyFips],
    );
    const fieldId = (f.rows[0] as { id: string }).id;
    const v = await writeBoundaryVersion(c, {
      fieldId,
      geometry: args.geometry,
      source: 'drawn',
      sourceRef: `drawn by ${args.actor.displayName}`,
    });
    const changes = new FieldChanges();
    changes.add(fieldId, 'identity', 'boundary');
    await changes.publish(c);
    return { fieldId, acres: v.acres };
  });
}

/**
 * Save the identity form. `version` is the farm.fields.updated_at the form was opened with: a
 * mismatch means someone else saved meanwhile. A Deere field's name stays as Ops Center has it.
 */
export async function updateFieldIdentity(
  pool: pg.Pool,
  args: {
    fieldId: string;
    identity: FieldIdentityInput;
    active: boolean;
    version: string | null;
    actor: Actor;
  },
): Promise<void> {
  checkIdentity(args.identity);
  await withTransaction(pool, async (c) => {
    const cur = await c.query<{
      name: string;
      deere_field_id: string | null;
      updated_at: Date;
      farm_id: string;
      tenure: string;
      landlord_party_id: string | null;
      county_fips: string | null;
      active: boolean;
    }>(
      `select name, deere_field_id, updated_at, farm_id, tenure, landlord_party_id, county_fips, active
         from farm.fields where id = $1 for update`,
      [args.fieldId],
    );
    const f = cur.rows[0];
    if (!f) throw new FieldDataError('field not found', 'not_found');
    if (args.version && iso(f.updated_at) !== args.version) {
      throw new FieldDataError('someone else changed this field: reload and try again', 'stale');
    }
    const name = args.identity.name.replace(/\s+/g, ' ').trim();
    if (f.deere_field_id && name !== f.name) {
      throw new FieldDataError(
        `${DEERE_BOUNDARY_READ_ONLY.replace('This boundary', 'This field')} (rename it there)`,
        'read_only',
      );
    }
    const farmId = await resolveFarm(c, args.identity);
    await checkLandlord(c, args.identity.landlordPartyId);
    if (args.active) await checkUniqueName(c, farmId, name, args.fieldId);
    const changed =
      name !== f.name ||
      farmId !== f.farm_id ||
      args.identity.tenure !== f.tenure ||
      args.identity.landlordPartyId !== f.landlord_party_id ||
      (args.identity.countyFips ?? null) !== f.county_fips ||
      args.active !== f.active;
    if (!changed) return;
    await c.query(
      `update farm.fields
          set name = $2, farm_id = $3, tenure = $4, landlord_party_id = $5, county_fips = $6,
              active = $7, updated_at = now()
        where id = $1`,
      [
        args.fieldId,
        name,
        farmId,
        args.identity.tenure,
        args.identity.landlordPartyId,
        args.identity.countyFips,
        args.active,
      ],
    );
    const changes = new FieldChanges();
    changes.add(args.fieldId, 'identity');
    await changes.publish(c);
  });
}

/** Show or hide the demo farm's fields (/admin/fields). Returns how many changed. */
export async function setDemoFieldsVisible(pool: pg.Pool, visible: boolean): Promise<number> {
  return withTransaction(pool, async (c) => {
    const changes = new FieldChanges();
    const n = await setDemoFieldsActive(c, visible, changes);
    await changes.publish(c);
    return n;
  });
}

export async function countDemoFields(ex: Queryable): Promise<{ active: number; hidden: number }> {
  const r = await ex.query<{ active: number; hidden: number }>(
    `select count(*) filter (where active)::int as active, count(*) filter (where not active)::int as hidden
       from farm.fields where source in ('demo', 'sim')`,
  );
  return r.rows[0] ?? { active: 0, hidden: 0 };
}
