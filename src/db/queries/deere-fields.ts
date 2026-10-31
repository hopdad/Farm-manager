/**
 * The deere.fields writers (slice 1f, docs/contracts-1f.md §5.4, §5.7, decisions 7 and 8; owner:
 * deere-data). Every function runs in the caller's transaction (a sync step's per-event `tx`):
 *
 *  - `upsertDeereField`: one field as one org lists it. Match order: the ('deere', 'field', id,
 *    org) ref; else `farm.fields.deere_field_id` (an Ops Center import), writing the ref; else
 *    create it (tenure `unknown`, in its Deere farm, else "Home farm" / the customer org's farm),
 *    only once a home org is known (`deereMayCreateRows`). The OWNING org (the org that created
 *    a synced field; else the org of its farm's Deere ref; else the home org) owns `name`,
 *    `deere_field_id` and `active = false` on archive (never `true`); the hand-entered overlays
 *    (tenure, landlord, county, notes) and fields hidden by hand are never touched.
 *  - the Deere boundary writer (decision 7): only the owning org's active boundary becomes a
 *    version (`source 'deere'`, `source_id '<boundary id>@<sha8>'` and `#<n>` on a return to an
 *    earlier geometry, id = deterministicId('deere', source_id)), written only when the current
 *    version's source or geometry differs; the previous version, whatever its source, is closed
 *    at now() and kept as history; the ('deere', 'boundary', …) ref is re-pointed. A sharing
 *    org's boundary only gets its ref, at the field's current version.
 *  - `upsertDeereMachines`: the Equipment API listing; machines match by the ('deere',
 *    'machine', principalId, org) ref, else are created from the HOME org only, when their kind
 *    maps; the others are counted by type name (`extra.unmappedKinds` of sync_state deere /
 *    equipment, merged, `writeUnmappedKinds`).
 *
 * Farms the sync creates get id deterministicId('deere', <farm id>) and `deere_farm_id`; in a
 * customer org their client is that org's party (decision 8: ref ('deere', 'party', org, org),
 * else the one client party the org's matched farms share, else created as source 'deere',
 * source_id 'org:<org>'); in the home org the Deere client's party, when Deere names one.
 * Changes publish `fields`/`updated` (parts `identity`, `boundary`) in the same transaction.
 */
import type { DeereFieldItem, DeereMachineItem } from '../../connectors/deere/fields/mapper';
import { deereMayCreateRows } from '../../connectors/deere/orgs';
import {
  externalRef,
  type NormalizedBoundary,
  type NormalizedField,
  type NormalizedRef,
} from '../../connectors/types';
import type { FieldPart } from '../../domain/fields';
import { deterministicId } from '../../domain/ids';
import { publish } from '../../platform/realtime/publish';
import { type Executor, exec } from '../exec';
import { resolveExternalRef, upsertExternalRef } from '../external-refs';
import { NORM_TEXT, NORMALIZED_POLYGON, normText } from './boundaries-sql';

/** The farm a field lands in when Deere names none (the boundary import's default too). */
export const DEERE_DEFAULT_FARM = 'Home farm';
/** source_id of "Home farm" when the sync has to create it. */
const DEFAULT_FARM_SOURCE_ID = 'default-farm';

// ---------------------------------------------------------------------------------------------
// Parties and farms (decision 8)
// ---------------------------------------------------------------------------------------------

async function rowExists(ex: Executor, table: string, id: string): Promise<boolean> {
  const r = await exec(ex, `select 1 from ${table} where id = $1::uuid`, [id]);
  return r.rowCount > 0;
}

/** The entity a ref points at, when that row still exists. */
async function resolveLive(
  ex: Executor,
  table: string,
  ref: ReturnType<typeof externalRef>,
): Promise<string | null> {
  const id = await resolveExternalRef(ex, ref);
  return id && (await rowExists(ex, table, id)) ? id : null;
}

async function insertParty(ex: Executor, sourceId: string, displayName: string): Promise<string> {
  const id = deterministicId('deere', sourceId);
  await exec(
    ex,
    `insert into farm.parties (id, kind, display_name, roles, source, source_id)
     values ($1::uuid, 'org', $2, '{customer}', 'deere', $3)
     on conflict do nothing`,
    [id, displayName, sourceId],
  );
  return id;
}

/**
 * The customer party of a non-home org (decision 8): its ('deere', 'party', org, org) ref; else
 * the one client party every already-matched farm of that org shares (the ref is then written);
 * else a party created from the org (kind org, role customer, source 'deere', 'org:<org>').
 */
export async function customerOrgParty(
  ex: Executor,
  orgId: string,
  orgName: string | null,
): Promise<string> {
  const ref = externalRef('deere', 'party', orgId, orgId);
  const known = await resolveLive(ex, 'farm.parties', ref);
  if (known) return known;
  const shared = await exec<{ client_party_id: string | null }>(
    ex,
    `select distinct f.client_party_id::text as client_party_id
       from ingest.external_refs r join farm.farms f on f.id = r.entity_id
      where r.source = 'deere' and r.kind = 'farm' and r.source_org = $1`,
    [orgId],
  );
  const only = shared.rows.length === 1 ? shared.rows[0]?.client_party_id : null;
  const id =
    only ?? (await insertParty(ex, `org:${orgId}`, orgName?.trim() || `Deere org ${orgId}`));
  await upsertExternalRef(ex, ref, id);
  return id;
}

/**
 * The party of a Deere client (a grower, in the home org): its ref; else the customer party of
 * that name (a party entered by hand or by the demo seed; the ref is then written); else created.
 */
export async function deereClientParty(
  ex: Executor,
  orgId: string,
  client: NormalizedRef,
): Promise<string> {
  const ref = externalRef('deere', 'party', client.externalId, orgId);
  const known = await resolveLive(ex, 'farm.parties', ref);
  if (known) return known;
  const byName = await exec<{ id: string }>(
    ex,
    `select id::text as id from farm.parties
      where ${NORM_TEXT('display_name')} = $1 and 'customer' = any(roles)
      order by (source in ('demo', 'sim')), created_at limit 1`,
    [normText(client.name)],
  );
  const id = byName.rows[0]?.id ?? (await insertParty(ex, client.externalId, client.name));
  await upsertExternalRef(ex, ref, id);
  return id;
}

/** "Home farm" (found by name, as the boundary import does; created when missing). */
async function defaultFarm(ex: Executor): Promise<string> {
  const found = await exec<{ id: string }>(
    ex,
    `select id::text as id from farm.farms where ${NORM_TEXT('name')} = $1
      order by (source in ('demo', 'sim')), created_at limit 1`,
    [normText(DEERE_DEFAULT_FARM)],
  );
  if (found.rows[0]) return found.rows[0].id;
  const id = deterministicId('deere', DEFAULT_FARM_SOURCE_ID);
  await exec(
    ex,
    `insert into farm.farms (id, name, source, source_id) values ($1::uuid, $2, 'deere', $3)
     on conflict do nothing`,
    [id, DEERE_DEFAULT_FARM, DEFAULT_FARM_SOURCE_ID],
  );
  return id;
}

/** Insert a farm the sync creates (deterministic id); returns its id. */
async function insertFarm(
  ex: Executor,
  a: { sourceId: string; name: string; deereFarmId: string | null; clientPartyId: string | null },
): Promise<string> {
  const id = deterministicId('deere', a.sourceId);
  await exec(
    ex,
    `insert into farm.farms (id, name, client_party_id, deere_farm_id, source, source_id)
     values ($1::uuid, $2, $3::uuid, $4, 'deere', $5)
     on conflict do nothing`,
    [id, a.name, a.clientPartyId, a.deereFarmId, a.sourceId],
  );
  return id;
}

/**
 * The farm a field the sync creates lands in: its Deere farm (matched by ref, else created, with
 * the client decision 8 gives it); without one, "Home farm" for the home org and the org's own
 * farm for a customer org.
 */
async function farmForNewField(
  ex: Executor,
  f: NormalizedField,
  homeOrgId: string,
  orgName: string | null,
): Promise<string> {
  const org = f.sourceOrg;
  const home = org === homeOrgId;
  const client = async () =>
    home
      ? f.client
        ? deereClientParty(ex, org, f.client)
        : null
      : customerOrgParty(ex, org, orgName);
  if (f.farm) {
    const ref = externalRef('deere', 'farm', f.farm.externalId, org);
    const known = await resolveLive(ex, 'farm.farms', ref);
    if (known) return known;
    const id = await insertFarm(ex, {
      sourceId: f.farm.externalId,
      name: f.farm.name.trim() || f.farm.externalId,
      deereFarmId: f.farm.externalId,
      clientPartyId: await client(),
    });
    await upsertExternalRef(ex, ref, id);
    return id;
  }
  if (home) return defaultFarm(ex);
  return insertFarm(ex, {
    sourceId: `org:${org}`,
    name: orgName?.trim() || `Deere org ${org}`,
    deereFarmId: null,
    clientPartyId: await client(),
  });
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

interface FieldRow {
  id: string;
  name: string;
  deere_field_id: string | null;
  active: boolean;
  farm_id: string;
  source: string;
  source_id: string | null;
}

async function lockField(ex: Executor, id: string): Promise<FieldRow | null> {
  const r = await exec<FieldRow>(
    ex,
    `select id::text as id, name, deere_field_id, active, farm_id::text as farm_id, source, source_id
       from farm.fields where id = $1::uuid for update`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * The org that owns a field's Deere data (docs/contracts-1f.md §5.7): for a field the sync
 * created, the org it was read from (the one whose field ref is its source_id); else the org of
 * its farm's ('deere', 'farm', …) ref (or the customer org of a farm the sync made for one);
 * else the home org (an imported farm is yours). Null when none of these is known.
 */
export async function owningOrg(
  ex: Executor,
  field: Pick<FieldRow, 'id' | 'farm_id' | 'source' | 'source_id'>,
  homeOrgId: string | null,
): Promise<string | null> {
  if (field.source === 'deere' && field.source_id) {
    const r = await exec<{ source_org: string }>(
      ex,
      `select source_org from ingest.external_refs
        where source = 'deere' and kind = 'field' and entity_id = $1::uuid and external_id = $2
        order by created_at limit 1`,
      [field.id, field.source_id],
    );
    if (r.rows[0]) return r.rows[0].source_org;
  }
  const farm = await exec<{ source_org: string | null; source: string; source_id: string | null }>(
    ex,
    `select (select r.source_org from ingest.external_refs r
              where r.source = 'deere' and r.kind = 'farm' and r.entity_id = f.id
              order by r.created_at limit 1) as source_org,
            f.source, f.source_id
       from farm.farms f where f.id = $1::uuid`,
    [field.farm_id],
  );
  const row = farm.rows[0];
  if (row?.source_org) return row.source_org;
  if (row?.source === 'deere' && row.source_id?.startsWith('org:')) return row.source_id.slice(4);
  return homeOrgId;
}

export type DeereFieldAction = 'matched_ref' | 'matched_deere_id' | 'created' | 'skipped';
export type DeereBoundaryAction = 'version' | 'unchanged' | 'ref' | 'none';

export interface DeereFieldResult {
  fieldId: string | null;
  action: DeereFieldAction;
  boundary: DeereBoundaryAction;
  /** The parts of the field that changed (published as fields/updated). */
  parts: FieldPart[];
  /** Why the field was skipped (no home org, archived, …), when it was. */
  reason?: string;
}

/** Find the field a Deere field maps to (ref, then deere_field_id, writing the ref). */
async function matchField(
  ex: Executor,
  f: NormalizedField,
): Promise<{ id: string; how: 'matched_ref' | 'matched_deere_id' } | null> {
  const ref = externalRef('deere', 'field', f.externalId, f.sourceOrg);
  const byRef = await resolveLive(ex, 'farm.fields', ref);
  if (byRef) return { id: byRef, how: 'matched_ref' };
  const byId = await exec<{ id: string }>(
    ex,
    `select id::text as id from farm.fields where deere_field_id = $1
      order by active desc, created_at limit 1`,
    [f.externalId],
  );
  const id = byId.rows[0]?.id;
  if (!id) return null;
  await upsertExternalRef(ex, ref, id);
  return { id, how: 'matched_deere_id' };
}

/** One field item of stream `fields` (see the file comment). */
export async function upsertDeereField(
  ex: Executor,
  item: DeereFieldItem,
): Promise<DeereFieldResult> {
  const f = item.field;
  const org = f.sourceOrg;
  const parts = new Set<FieldPart>();
  let matched = await matchField(ex, f);
  let action: DeereFieldAction;
  if (matched) action = matched.how;
  else {
    if (!deereMayCreateRows({ orgId: item.homeOrgId, source: 'unknown' })) {
      return {
        fieldId: null,
        action: 'skipped',
        boundary: 'none',
        parts: [],
        reason: 'no home org',
      };
    }
    if (f.archived) {
      return { fieldId: null, action: 'skipped', boundary: 'none', parts: [], reason: 'archived' };
    }
    const farmId = await farmForNewField(ex, f, item.homeOrgId as string, item.orgName);
    const id = deterministicId('deere', f.externalId);
    await exec(
      ex,
      `insert into farm.fields (id, farm_id, name, tenure, deere_field_id, active, source, source_id)
       values ($1::uuid, $2::uuid, $3, 'unknown', $4, true, 'deere', $4)
       on conflict do nothing`,
      [id, farmId, f.name, f.externalId],
    );
    await upsertExternalRef(ex, externalRef('deere', 'field', f.externalId, org), id);
    matched = { id, how: 'matched_ref' };
    action = 'created';
    parts.add('identity');
  }

  const row = await lockField(ex, matched.id);
  if (!row)
    return { fieldId: null, action: 'skipped', boundary: 'none', parts: [], reason: 'gone' };
  const owner = await owningOrg(ex, row, item.homeOrgId);
  const isOwner = owner === org;
  let boundary: DeereBoundaryAction = 'none';

  // A field hidden by hand (or archived before) is left as it is: refs only.
  if (row.active) {
    if (isOwner) {
      const upd = await exec(
        ex,
        `update farm.fields
            set name = $2, deere_field_id = $3,
                active = case when $4::boolean then false else active end,
                updated_at = now()
          where id = $1::uuid
            and (name is distinct from $2 or deere_field_id is distinct from $3 or $4::boolean)`,
        [row.id, f.name, f.externalId, f.archived],
      );
      if (upd.rowCount > 0) parts.add('identity');
    }
    if (f.boundary) {
      boundary = isOwner
        ? await writeDeereBoundary(ex, row.id, f.boundary)
        : await pointSharedBoundary(ex, row.id, f.boundary);
      if (boundary === 'version') parts.add('boundary');
    }
  } else if (f.boundary && !isOwner) {
    boundary = await pointSharedBoundary(ex, row.id, f.boundary);
  }

  const changed = [...parts].sort();
  if (changed.length) {
    await publish('fields', 'updated', { fieldId: row.id, parts: changed }, ex);
  }
  return { fieldId: row.id, action, boundary, parts: changed };
}

// ---------------------------------------------------------------------------------------------
// The Deere boundary writer (decision 7)
// ---------------------------------------------------------------------------------------------

interface CurrentVersion {
  id: string;
  source: string;
  same: boolean;
  started_in_future: boolean;
}

/** The field's open version, compared with `geojson` (normalized like every boundary write). */
async function currentVersion(
  ex: Executor,
  fieldId: string,
  geojson: string,
): Promise<CurrentVersion | null> {
  const r = await exec<CurrentVersion>(
    ex,
    `select b.id::text as id, b.source,
            extensions.ST_Equals(b.geom, ${NORMALIZED_POLYGON('$2')}) as same,
            lower(b.valid) >= now() as started_in_future
       from farm.field_boundaries b
      where b.field_id = $1::uuid and upper_inf(b.valid)
      order by lower(b.valid) desc nulls first
      limit 1`,
    [fieldId, geojson],
  );
  return r.rows[0] ?? null;
}

/**
 * The owning org's active boundary as the field's current version (decision 7, §5.7 steps 2-5):
 * unchanged when the current version is a Deere one with an equal geometry (a different Deere
 * boundary id with an equal geometry only gets its ref); else a new version, the previous one
 * closed at now() (whatever its source), the ref re-pointed, and the sharing orgs' refs that
 * pointed at the closed version moved to the new one.
 */
export async function writeDeereBoundary(
  ex: Executor,
  fieldId: string,
  b: NormalizedBoundary,
): Promise<DeereBoundaryAction> {
  const geojson = JSON.stringify(b.geom);
  const ref = externalRef('deere', 'boundary', b.externalId, b.sourceOrg);
  const g = await exec<{ empty: boolean; sha8: string }>(
    ex,
    `select extensions.ST_IsEmpty(g) as empty,
            left(encode(sha256(extensions.ST_AsBinary(g)), 'hex'), 8) as sha8
       from (select ${NORMALIZED_POLYGON('$1')} as g) q`,
    [geojson],
  );
  const shape = g.rows[0];
  if (!shape || shape.empty) return 'none';
  const current = await currentVersion(ex, fieldId, geojson);
  if (current && current.source === 'deere' && current.same) {
    await upsertExternalRef(ex, ref, current.id);
    return 'unchanged';
  }
  // A current version that starts later than now (a future-dated import) can't be closed now.
  if (current?.started_in_future) return 'none';

  const base = `${b.externalId}@${shape.sha8}`;
  const taken = await exec<{ n: number }>(
    ex,
    `select count(*)::int as n from farm.field_boundaries
      where source = 'deere' and (source_id = $1 or starts_with(source_id, $1 || '#'))`,
    [base],
  );
  const n = taken.rows[0]?.n ?? 0;
  const sourceId = n === 0 ? base : `${base}#${n}`;
  const id = deterministicId('deere', sourceId);
  if (current) {
    await exec(
      ex,
      `update farm.field_boundaries set valid = tstzrange(lower(valid), now(), '[)')
        where id = $1::uuid`,
      [current.id],
    );
  }
  await exec(
    ex,
    `insert into farm.field_boundaries (id, field_id, geom, valid, source, source_id, source_ref)
     values ($1::uuid, $2::uuid, ${NORMALIZED_POLYGON('$3')}, tstzrange(now(), null, '[)'),
             'deere', $4, $5)`,
    [id, fieldId, geojson, sourceId, b.name],
  );
  await exec(ex, 'update farm.fields set updated_at = now() where id = $1::uuid', [fieldId]);
  await upsertExternalRef(ex, ref, id);
  if (current) {
    await exec(
      ex,
      `update ingest.external_refs set entity_id = $2::uuid, updated_at = now()
        where source = 'deere' and kind = 'boundary' and entity_id = $1::uuid
          and source_org <> $3`,
      [current.id, id, b.sourceOrg],
    );
  }
  return 'version';
}

/** A sharing org's boundary: only its ref, at the field's current version (never a version). */
export async function pointSharedBoundary(
  ex: Executor,
  fieldId: string,
  b: NormalizedBoundary,
): Promise<DeereBoundaryAction> {
  const r = await exec<{ id: string }>(
    ex,
    `select id::text as id from farm.field_boundaries
      where field_id = $1::uuid and upper_inf(valid)
      order by lower(valid) desc nulls first limit 1`,
    [fieldId],
  );
  const current = r.rows[0]?.id;
  if (!current) return 'none';
  await upsertExternalRef(ex, externalRef('deere', 'boundary', b.externalId, b.sourceOrg), current);
  return 'ref';
}

// ---------------------------------------------------------------------------------------------
// Machines (Equipment API)
// ---------------------------------------------------------------------------------------------

export interface DeereMachinesResult {
  matched: number;
  created: string[];
  /** Unmappable, unmatched machines of the home org, by type name. */
  unmappedKinds: Record<string, number>;
  /** Machines skipped because no home org is known or they belong to another org. */
  skipped: number;
}

/**
 * The Equipment API listing of one run (stream `equipment`). A machine maps through its
 * ('deere', 'machine', principalId, org) ref; an unmapped one is created only from the home org
 * and only when its kind maps (id deterministicId('deere', principalId), kind_set_by 'vendor');
 * archived machines are never created. A matched machine is not changed.
 */
export async function upsertDeereMachines(
  ex: Executor,
  homeOrgId: string | null,
  items: readonly DeereMachineItem[],
): Promise<DeereMachinesResult> {
  const out: DeereMachinesResult = { matched: 0, created: [], unmappedKinds: {}, skipped: 0 };
  for (const item of items) {
    const m = item.machine;
    const ref = externalRef('deere', 'machine', m.externalId, m.sourceOrg);
    if (await resolveLive(ex, 'farm.machines', ref)) {
      out.matched++;
      continue;
    }
    if (!homeOrgId || m.sourceOrg !== homeOrgId || item.archived) {
      out.skipped++;
      continue;
    }
    if (!m.kind) {
      out.unmappedKinds[item.typeName] = (out.unmappedKinds[item.typeName] ?? 0) + 1;
      continue;
    }
    const id = deterministicId('deere', m.externalId);
    await exec(
      ex,
      `insert into farm.machines (id, kind, unit_no, make, model, year, vin_serial, source,
                                  source_id, kind_set_by)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, 'deere', $8, 'vendor')
       on conflict do nothing`,
      [id, m.kind, m.name, m.make, m.model, m.year, m.vin, m.externalId],
    );
    await upsertExternalRef(ex, ref, id);
    out.created.push(id);
  }
  return out;
}

const sortedJson = (o: Record<string, number>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/**
 * `ingest.sync_state` (deere, equipment) `extra.unmappedKinds`, replaced (merged into extra, the
 * other keys kept). Returns true when the list changed (the caller logs it only then).
 */
export async function writeUnmappedKinds(
  ex: Executor,
  kinds: Record<string, number>,
): Promise<boolean> {
  const next = sortedJson(kinds);
  const r = await exec<{ prev: Record<string, number> | null }>(
    ex,
    `select extra->'unmappedKinds' as prev from ingest.sync_state
      where source = 'deere' and stream = 'equipment'`,
  );
  const prev = r.rows[0]?.prev ?? null;
  if (prev !== null && sortedJson(prev) === next) return false;
  await exec(
    ex,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('unmappedKinds', $1::jsonb)
      where source = 'deere' and stream = 'equipment'`,
    [next],
  );
  return prev !== null || Object.keys(kinds).length > 0;
}
