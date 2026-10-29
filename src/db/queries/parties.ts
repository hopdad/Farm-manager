/**
 * People and organizations (farm.parties, plan 1c "landlords, customers and crew through admin
 * forms and CSV import"), and the links the field panel shows: a field's landlord
 * (fields.landlord_party_id) and a farm's custom-work customer (farms.client_party_id, so every
 * field of that farm is the customer's).
 *
 * Contact changes publish fields/updated ('identity') for every field that shows the party, so
 * open panels refetch. Rows the app writes: source 'app' (forms) or 'import' (CSV). Demo rows
 * (source demo/sim) can be edited but are never exported (data:export).
 */
import type pg from 'pg';
import { PARTY_KINDS, PARTY_ROLES, type PartyKind, type PartyRole } from '../../domain/farm';
import type { Queryable } from '../client';
import {
  type Actor,
  FieldChanges,
  FieldDataError,
  iso,
  NORM_TEXT,
  normText,
  withTransaction,
} from './boundaries-sql';

export interface PartyInput {
  kind: PartyKind;
  displayName: string;
  roles: PartyRole[];
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  /** The organization a person belongs to. */
  orgId: string | null;
}

export interface RawPartyInput {
  kind?: string;
  displayName?: string;
  roles?: string | string[];
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  orgId?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+().\-\s#*x]+$/i;
const ORG_WORDS =
  /\b(llc|l\.l\.c\.|inc|corp|co\.|company|farms?|bros\.?|trust|partnership|elevator|grain|coop|co-op|cooperative|ltd)\b/i;

/** "landlord; customer" / ["Landlord"] -> ['landlord', 'customer'], or the unknown ones. */
export function parseRoles(raw: string | string[] | undefined): {
  roles: PartyRole[];
  unknown: string[];
} {
  const parts = (Array.isArray(raw) ? raw : (raw ?? '').split(/[;|,/]+/))
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const roles: PartyRole[] = [];
  const unknown: string[] = [];
  const known = PARTY_ROLES as readonly string[];
  for (const p of parts) {
    // 'Landlords' in a header-ish cell means 'landlord'.
    const role = known.includes(p)
      ? p
      : known.includes(p.replace(/s$/, ''))
        ? p.replace(/s$/, '')
        : null;
    if (role) {
      if (!roles.includes(role as PartyRole)) roles.push(role as PartyRole);
    } else {
      unknown.push(p);
    }
  }
  return { roles, unknown };
}

const clean = (s: string | undefined | null) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v === '' ? null : v;
};

/** Check a form or CSV row (pure). */
export function validateParty(
  raw: RawPartyInput,
): { ok: true; value: PartyInput; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const displayName = clean(raw.displayName);
  if (!displayName) errors.push('the name is empty');
  else if (displayName.length > 120) errors.push('the name is longer than 120 characters');
  const kindText = clean(raw.kind)?.toLowerCase() ?? null;
  let kind: PartyKind = 'person';
  if (kindText) {
    const k = kindText === 'organization' || kindText === 'company' ? 'org' : kindText;
    if ((PARTY_KINDS as readonly string[]).includes(k)) kind = k as PartyKind;
    else errors.push(`kind '${raw.kind}' is not person or org`);
  } else if (displayName && ORG_WORDS.test(displayName)) {
    warnings.push(`'${displayName}' looks like an organization: set kind to org if it is one`);
  }
  const { roles, unknown } = parseRoles(raw.roles);
  if (unknown.length) {
    errors.push(`unknown role(s): ${unknown.join(', ')} (roles: ${PARTY_ROLES.join(', ')})`);
  }
  const email = clean(raw.email)?.toLowerCase() ?? null;
  if (email && (!EMAIL_RE.test(email) || email.length > 200))
    errors.push(`'${raw.email}' is not an email address`);
  const phone = clean(raw.phone);
  if (phone && (!PHONE_RE.test(phone) || phone.length > 40))
    errors.push(`'${raw.phone}' is not a phone number`);
  const address = clean(raw.address);
  if (address && address.length > 300) errors.push('the address is longer than 300 characters');
  const notes = (raw.notes ?? '').trim() || null;
  if (notes && notes.length > 4000) errors.push('the notes are longer than 4000 characters');
  if (errors.length || !displayName) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      displayName,
      roles,
      phone,
      email,
      address,
      notes,
      orgId: kind === 'person' ? (raw.orgId ?? null) : null,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface PartyListRow {
  id: string;
  kind: PartyKind;
  displayName: string;
  roles: PartyRole[];
  phone: string | null;
  email: string | null;
  orgName: string | null;
  source: string;
  landlordOf: number;
  customerOf: number;
}

export async function listParties(
  ex: Queryable,
  opts: { role?: PartyRole | null; q?: string | null; includeDemo?: boolean } = {},
): Promise<PartyListRow[]> {
  const q = opts.q?.trim() ? `%${normText(opts.q)}%` : null;
  const r = await ex.query<{
    id: string;
    kind: PartyKind;
    display_name: string;
    roles: PartyRole[];
    phone: string | null;
    email: string | null;
    org_name: string | null;
    source: string;
    landlord_of: number;
    customer_of: number;
  }>(
    `select p.id, p.kind, p.display_name, p.roles, p.phone, p.email, o.display_name as org_name,
            p.source,
            (select count(*)::int from farm.fields f where f.landlord_party_id = p.id and f.active) as landlord_of,
            (select count(*)::int from farm.farms fa where fa.client_party_id = p.id) as customer_of
       from farm.parties p left join farm.parties o on o.id = p.org_id
      where ($1::text is null or $1 = any (p.roles))
        and ($2::text is null or ${NORM_TEXT('p.display_name')} like $2
             or lower(coalesce(p.email, '')) like $2 or coalesce(p.phone, '') like $2)
        and ($3 or p.source not in ('demo', 'sim'))
      order by p.source in ('demo', 'sim'), lower(p.display_name)
      limit 2000`,
    [opts.role ?? null, q, opts.includeDemo ?? true],
  );
  return r.rows.map((x) => ({
    id: x.id,
    kind: x.kind,
    displayName: x.display_name,
    roles: x.roles,
    phone: x.phone,
    email: x.email,
    orgName: x.org_name,
    source: x.source,
    landlordOf: x.landlord_of,
    customerOf: x.customer_of,
  }));
}

export interface PartyDetail extends PartyListRow {
  address: string | null;
  notes: string | null;
  orgId: string | null;
  members: { id: string; displayName: string }[];
  landlordFields: { fieldId: string; name: string; farmName: string; acres: number | null }[];
  customerFarms: { farmId: string; name: string; fieldCount: number }[];
  /** Signs in to the app (farm.app_users): managed on /admin/people. */
  appUserRole: string | null;
  version: string;
}

export async function getParty(ex: Queryable, id: string): Promise<PartyDetail | null> {
  const list = await ex.query<{
    id: string;
    kind: PartyKind;
    display_name: string;
    roles: PartyRole[];
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    org_id: string | null;
    org_name: string | null;
    source: string;
    updated_at: Date;
    app_user_role: string | null;
  }>(
    `select p.id, p.kind, p.display_name, p.roles, p.phone, p.email, p.address, p.notes, p.org_id,
            o.display_name as org_name, p.source, p.updated_at, u.role as app_user_role
       from farm.parties p
       left join farm.parties o on o.id = p.org_id
       left join farm.app_users u on u.party_id = p.id
      where p.id = $1`,
    [id],
  );
  const p = list.rows[0];
  if (!p) return null;
  const [members, fields, farms] = await Promise.all([
    ex.query<{ id: string; display_name: string }>(
      'select id, display_name from farm.parties where org_id = $1 order by lower(display_name)',
      [id],
    ),
    ex.query<{ id: string; name: string; farm_name: string; acres: number | null }>(
      `select f.id, f.name, fa.name as farm_name, b.acres::float8 as acres
         from farm.fields f join farm.farms fa on fa.id = f.farm_id
         left join farm.current_boundaries b on b.field_id = f.id
        where f.landlord_party_id = $1 and f.active order by fa.name, f.name`,
      [id],
    ),
    ex.query<{ id: string; name: string; field_count: number }>(
      `select fa.id, fa.name,
              (select count(*)::int from farm.fields f where f.farm_id = fa.id and f.active) as field_count
         from farm.farms fa where fa.client_party_id = $1 order by fa.name`,
      [id],
    ),
  ]);
  return {
    id: p.id,
    kind: p.kind,
    displayName: p.display_name,
    roles: p.roles,
    phone: p.phone,
    email: p.email,
    orgName: p.org_name,
    source: p.source,
    landlordOf: fields.rows.length,
    customerOf: farms.rows.length,
    address: p.address,
    notes: p.notes,
    orgId: p.org_id,
    members: members.rows.map((m) => ({ id: m.id, displayName: m.display_name })),
    landlordFields: fields.rows.map((f) => ({
      fieldId: f.id,
      name: f.name,
      farmName: f.farm_name,
      acres: f.acres,
    })),
    customerFarms: farms.rows.map((f) => ({
      farmId: f.id,
      name: f.name,
      fieldCount: f.field_count,
    })),
    appUserRole: p.app_user_role,
    version: iso(p.updated_at) as string,
  };
}

/** Organizations, for the "works for" picker. */
export async function listOrgs(ex: Queryable): Promise<{ id: string; displayName: string }[]> {
  const r = await ex.query<{ id: string; display_name: string }>(
    `select id, display_name from farm.parties where kind = 'org' order by lower(display_name)`,
  );
  return r.rows.map((x) => ({ id: x.id, displayName: x.display_name }));
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** Fields whose panel shows this party (as landlord, or through their farm's customer). */
async function fieldsShowing(
  c: pg.PoolClient,
  partyId: string,
  changes: FieldChanges,
): Promise<void> {
  const r = await c.query<{ id: string }>(
    `select f.id from farm.fields f join farm.farms fa on fa.id = f.farm_id
      where f.landlord_party_id = $1 or fa.client_party_id = $1`,
    [partyId],
  );
  for (const row of r.rows) changes.add(row.id, 'identity');
}

async function checkOrg(
  c: pg.PoolClient,
  orgId: string | null,
  self: string | null,
): Promise<void> {
  if (!orgId) return;
  if (orgId === self) throw new FieldDataError('a party cannot belong to itself');
  const r = await c.query<{ kind: string }>('select kind from farm.parties where id = $1', [orgId]);
  if (!r.rows[0]) throw new FieldDataError('that organization no longer exists', 'stale');
  if (r.rows[0].kind !== 'org') throw new FieldDataError('"works for" must be an organization');
}

export async function createParty(
  pool: pg.Pool,
  input: PartyInput,
  _actor: Actor,
  source: 'app' | 'import' = 'app',
): Promise<string> {
  return withTransaction(pool, async (c) => {
    await checkOrg(c, input.orgId, null);
    const r = await c.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles, phone, email, address, notes, org_id, source)
       values ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9) returning id`,
      [
        input.kind,
        input.displayName,
        input.roles,
        input.phone,
        input.email,
        input.address,
        input.notes,
        input.orgId,
        source,
      ],
    );
    return (r.rows[0] as { id: string }).id;
  });
}

export async function updateParty(
  pool: pg.Pool,
  args: { id: string; input: PartyInput; version: string | null; actor: Actor },
): Promise<void> {
  await withTransaction(pool, async (c) => {
    const cur = await c.query<{ updated_at: Date }>(
      'select updated_at from farm.parties where id = $1 for update',
      [args.id],
    );
    if (!cur.rows[0]) throw new FieldDataError('that party no longer exists', 'not_found');
    if (args.version && iso(cur.rows[0].updated_at) !== args.version) {
      throw new FieldDataError('someone else changed this party: reload and try again', 'stale');
    }
    await checkOrg(c, args.input.orgId, args.id);
    if (args.input.kind === 'person') {
      const members = await c.query('select 1 from farm.parties where org_id = $1 limit 1', [
        args.id,
      ]);
      if (members.rowCount) {
        throw new FieldDataError('people work for this organization: it must stay an organization');
      }
    }
    const i = args.input;
    const r = await c.query(
      `update farm.parties as t
          set kind = $2, display_name = $3, roles = $4::text[], phone = $5, email = $6, address = $7,
              notes = $8, org_id = $9, updated_at = now()
        where id = $1
          and (t.kind, t.display_name, t.roles, t.phone, t.email, t.address, t.notes, t.org_id)
              is distinct from ($2, $3, $4::text[], $5, $6, $7, $8, $9::uuid)`,
      [args.id, i.kind, i.displayName, i.roles, i.phone, i.email, i.address, i.notes, i.orgId],
    );
    if (!r.rowCount) return;
    const changes = new FieldChanges();
    await fieldsShowing(c, args.id, changes);
    await changes.publish(c);
  });
}

/** Delete a party nothing points at (refuses, listing the links, otherwise). */
export async function deleteParty(pool: pg.Pool, id: string, _actor: Actor): Promise<void> {
  await withTransaction(pool, async (c) => {
    const r = await c.query<{
      found: boolean;
      fields: number;
      farms: number;
      members: number;
      user: boolean;
      geofences: number;
    }>(
      `select exists (select 1 from farm.parties where id = $1) as found,
              (select count(*)::int from farm.fields where landlord_party_id = $1) as fields,
              (select count(*)::int from farm.farms where client_party_id = $1) as farms,
              (select count(*)::int from farm.parties where org_id = $1) as members,
              exists (select 1 from farm.app_users where party_id = $1) as user,
              (select count(*)::int from farm.geofences where party_id = $1) as geofences`,
      [id],
    );
    const x = r.rows[0];
    if (!x?.found) throw new FieldDataError('that party no longer exists', 'not_found');
    const links = [
      x.fields && `landlord of ${x.fields} field(s)`,
      x.farms && `customer of ${x.farms} farm(s)`,
      x.members && `${x.members} member(s)`,
      x.user && 'an app sign-in (/admin/people)',
      x.geofences && `${x.geofences} geofence(s)`,
    ].filter(Boolean);
    if (links.length) {
      throw new FieldDataError(
        `still linked: ${links.join(', ')}. Unlink those first.`,
        'conflict',
      );
    }
    await c.query('update farm.parties set introduced_by = null where introduced_by = $1', [id]);
    await c.query('delete from farm.parties where id = $1', [id]);
  });
}

/** Set (or clear) a field's landlord. */
export async function setFieldLandlord(
  pool: pg.Pool,
  args: { fieldId: string; partyId: string | null; actor: Actor },
): Promise<void> {
  await withTransaction(pool, async (c) => {
    if (args.partyId) {
      const p = await c.query('select 1 from farm.parties where id = $1', [args.partyId]);
      if (!p.rowCount) throw new FieldDataError('that party no longer exists', 'stale');
    }
    const r = await c.query(
      `update farm.fields set landlord_party_id = $2, updated_at = now()
        where id = $1 and landlord_party_id is distinct from $2::uuid`,
      [args.fieldId, args.partyId],
    );
    if (!r.rowCount) {
      const exists = await c.query('select 1 from farm.fields where id = $1', [args.fieldId]);
      if (!exists.rowCount) throw new FieldDataError('field not found', 'not_found');
      return;
    }
    const changes = new FieldChanges();
    changes.add(args.fieldId, 'identity');
    await changes.publish(c);
  });
}

/** Make a farm a customer's (custom work), or your own again (null). */
export async function setFarmClient(
  pool: pg.Pool,
  args: { farmId: string; partyId: string | null; actor: Actor },
): Promise<void> {
  await withTransaction(pool, async (c) => {
    if (args.partyId) {
      const p = await c.query('select 1 from farm.parties where id = $1', [args.partyId]);
      if (!p.rowCount) throw new FieldDataError('that party no longer exists', 'stale');
    }
    const r = await c.query(
      `update farm.farms set client_party_id = $2, updated_at = now()
        where id = $1 and client_party_id is distinct from $2::uuid`,
      [args.farmId, args.partyId],
    );
    if (!r.rowCount) {
      const exists = await c.query('select 1 from farm.farms where id = $1', [args.farmId]);
      if (!exists.rowCount) throw new FieldDataError('farm not found', 'not_found');
      return;
    }
    const changes = new FieldChanges();
    const f = await c.query<{ id: string }>('select id from farm.fields where farm_id = $1', [
      args.farmId,
    ]);
    for (const row of f.rows) changes.add(row.id, 'identity');
    await changes.publish(c);
  });
}

// ---------------------------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------------------------

/** A checked CSV row (tools/import/parties-csv.ts); `org` is an organization's name. */
export interface PartyImportRow extends PartyInput {
  line: number;
  org: string | null;
}

export interface PartyImportRowResult {
  line: number;
  name: string;
  action: 'insert' | 'update' | 'unchanged' | 'error' | 'blocked';
  partyId: string | null;
  message: string | null;
}

export interface PartyImportReport {
  dryRun: boolean;
  written: boolean;
  rows: PartyImportRowResult[];
  counts: Record<PartyImportRowResult['action'], number>;
}

/**
 * Import contacts. A row whose name matches a party the app or an earlier import made (not a
 * demo one) updates it: roles are added, filled-in cells replace, empty cells keep what is
 * there. Organizations named in the `org` column must exist or be in the file. All or nothing.
 */
export async function importParties(
  pool: pg.Pool,
  rows: readonly PartyImportRow[],
  opts: { dryRun?: boolean } = {},
): Promise<PartyImportReport> {
  const dryRun = opts.dryRun ?? false;
  return withTransaction(
    pool,
    async (c) => {
      const results: PartyImportRowResult[] = rows.map((r) => ({
        line: r.line,
        name: r.displayName,
        action: 'blocked',
        partyId: null,
        message: null,
      }));
      const existing = await c.query<{
        id: string;
        display_name: string;
        kind: string;
        source: string;
      }>(`select id, display_name, kind, source from farm.parties`);
      const own = new Map<string, string>();
      const orgs = new Map<string, string>();
      for (const p of existing.rows) {
        const k = normText(p.display_name);
        if (p.source !== 'demo' && p.source !== 'sim' && !own.has(k)) own.set(k, p.id);
        if (p.kind === 'org' && !orgs.has(k)) orgs.set(k, p.id);
      }
      const inFileOrgs = new Set(
        rows.filter((r) => r.kind === 'org').map((r) => normText(r.displayName)),
      );
      rows.forEach((r, i) => {
        const res = results[i] as PartyImportRowResult;
        if (r.org && !orgs.has(normText(r.org)) && !inFileOrgs.has(normText(r.org))) {
          res.action = 'error';
          res.message = `no organization named '${r.org}' (add it as a row with kind org)`;
        }
        if (r.org && r.kind === 'org') {
          res.action = 'error';
          res.message = 'an organization cannot work for another (leave org empty)';
        }
      });
      if (results.some((r) => r.action === 'error')) {
        const counts = { insert: 0, update: 0, unchanged: 0, error: 0, blocked: 0 };
        for (const r of results) counts[r.action]++;
        return { dryRun, written: false, rows: results, counts };
      }
      const changes = new FieldChanges();
      // Organizations first, so people can point at them.
      const order = [...rows.keys()].sort(
        (a, b) => Number(rows[a]?.kind !== 'org') - Number(rows[b]?.kind !== 'org'),
      );
      for (const i of order) {
        const r = rows[i] as PartyImportRow;
        const res = results[i] as PartyImportRowResult;
        const orgId = r.org ? (orgs.get(normText(r.org)) ?? null) : null;
        const match = own.get(normText(r.displayName));
        if (!match) {
          const ins = await c.query<{ id: string }>(
            `insert into farm.parties (kind, display_name, roles, phone, email, address, notes, org_id, source)
             values ($1, $2, $3::text[], $4, $5, $6, $7, $8, 'import') returning id`,
            [r.kind, r.displayName, r.roles, r.phone, r.email, r.address, r.notes, orgId],
          );
          res.partyId = (ins.rows[0] as { id: string }).id;
          res.action = 'insert';
          own.set(normText(r.displayName), res.partyId);
        } else {
          const upd = await c.query(
            `update farm.parties as t
                set roles = n.roles, phone = n.phone, email = n.email, address = n.address,
                    notes = n.notes, org_id = n.org_id, updated_at = now()
               from (select p.id,
                            p.roles || array(select x from unnest($2::text[]) x
                                              where not (x = any (p.roles))) as roles,
                            coalesce($3, p.phone) as phone, coalesce($4, p.email) as email,
                            coalesce($5, p.address) as address, coalesce($6, p.notes) as notes,
                            coalesce($7::uuid, p.org_id) as org_id
                       from farm.parties p where p.id = $1) n
              where t.id = n.id
                and (t.roles, t.phone, t.email, t.address, t.notes, t.org_id)
                    is distinct from (n.roles, n.phone, n.email, n.address, n.notes, n.org_id)`,
            [match, r.roles, r.phone, r.email, r.address, r.notes, orgId],
          );
          res.partyId = match;
          res.action = upd.rowCount ? 'update' : 'unchanged';
          if (upd.rowCount) await fieldsShowing(c, match, changes);
        }
        if (r.kind === 'org') orgs.set(normText(r.displayName), res.partyId as string);
      }
      await changes.publish(c);
      const counts = { insert: 0, update: 0, unchanged: 0, error: 0, blocked: 0 };
      for (const r of results) counts[r.action]++;
      return { dryRun, written: !dryRun, rows: results, counts };
    },
    { rollback: dryRun },
  );
}
