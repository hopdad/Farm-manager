/**
 * farm.data_rights_agreements and the Deere org -> customer party links (D17, decision 2a-10;
 * docs/contracts-2a.md §4.4, §7.6; owner: rights-usage).
 *
 *  - The org -> party resolution is READ-ONLY and the same rule `customerOrgParty`
 *    (./deere-fields.ts) applies when the fields sync meets a customer org: the ('deere',
 *    'party', <org>, <org>) ref when its party still exists; else the one client party every
 *    farm of that org (its ('deere', 'farm', …, <org>) refs) shares, when no farm of it is
 *    unassigned. Never wider (no name matching), never a write: the gate must not create the
 *    party it then reads an agreement for.
 *  - `agreedDeereOrgIds`: the orgs whose party has an agreement in force (`revoked_on` null):
 *    the gate's one query per run (src/connectors/deere/rights.ts `loadOrgReadRights`).
 *  - `deereOrgParties`: the same resolution with the party's name and agreement count, for
 *    /admin/connectors' org rows.
 *  - `linkDeereOrgToParty`: /admin/connectors' "link to customer": writes the ('deere', 'party',
 *    <org>, <org>) ref for an org that has no party yet, so an agreement can be recorded before
 *    the first fields sync (which then finds the link first).
 *  - Agreements per party: list, record (with the signed document's key in the private `uploads`
 *    bucket), revoke. Agreements are never deleted here (revoked ones stay as history); the
 *    party delete refuses while one exists (`deleteParty`'s link list, jobs-api's line).
 */
import { externalRef } from '../../connectors/types';
import type { AgreementInput } from '../../domain/data-rights';
import type { PartyKind } from '../../domain/farm';
import type { PermittedUse } from '../../domain/work-jobs';
import { type Executor, exec, toDate } from '../exec';
import { upsertExternalRef } from '../external-refs';

/**
 * Every Deere org a party can be resolved for, with that party and how it was resolved. A CTE
 * the queries below select from (no parameters).
 */
const ORG_PARTIES_CTE = `
  org_parties as (
    select coalesce(ref.org_id, farms.org_id) as org_id,
           coalesce(ref.party_id, farms.party_id) as party_id,
           case when ref.party_id is not null then 'ref' else 'farms' end as linked_by
      from (
        select r.external_id as org_id, p.id as party_id
          from ingest.external_refs r
          join farm.parties p on p.id = r.entity_id
         where r.source = 'deere' and r.kind = 'party' and r.external_id = r.source_org
      ) ref
      full join (
        select r.source_org as org_id, min(f.client_party_id::text)::uuid as party_id
          from ingest.external_refs r
          join farm.farms f on f.id = r.entity_id
         where r.source = 'deere' and r.kind = 'farm'
         group by r.source_org
        having count(distinct f.client_party_id) = 1 and bool_and(f.client_party_id is not null)
      ) farms on farms.org_id = ref.org_id
  )`;

/** Deere org ids whose customer party has an agreement in force (the gate's read). */
export async function agreedDeereOrgIds(ex: Executor): Promise<Set<string>> {
  const r = await exec<{ org_id: string }>(
    ex,
    `with ${ORG_PARTIES_CTE}
     select distinct op.org_id
       from org_parties op
      where exists (select 1 from farm.data_rights_agreements a
                     where a.party_id = op.party_id and a.revoked_on is null)`,
  );
  return new Set(r.rows.map((row) => row.org_id));
}

/** One Deere org's customer party as the gate resolves it. */
export interface DeereOrgParty {
  orgId: string;
  partyId: string;
  partyName: string;
  partyKind: PartyKind;
  /** 'ref': the ('deere', 'party', org, org) link; 'farms': the client party its farms share. */
  linkedBy: 'ref' | 'farms';
  /** Agreements in force (revoked_on null). */
  agreementsInForce: number;
}

/** The customer party of each of these orgs, when one resolves (absent = no party yet). */
export async function deereOrgParties(
  ex: Executor,
  orgIds: readonly string[],
): Promise<Map<string, DeereOrgParty>> {
  const out = new Map<string, DeereOrgParty>();
  const ids = [...new Set(orgIds)];
  if (!ids.length) return out;
  const r = await exec<{
    org_id: string;
    party_id: string;
    party_name: string;
    party_kind: PartyKind;
    linked_by: 'ref' | 'farms';
    in_force: number;
  }>(
    ex,
    `with ${ORG_PARTIES_CTE}
     select op.org_id, op.party_id::text as party_id, p.display_name as party_name,
            p.kind as party_kind, op.linked_by,
            (select count(*)::int from farm.data_rights_agreements a
              where a.party_id = op.party_id and a.revoked_on is null) as in_force
       from org_parties op
       join farm.parties p on p.id = op.party_id
      where op.org_id = any($1::text[])`,
    [ids],
  );
  for (const row of r.rows) {
    out.set(row.org_id, {
      orgId: row.org_id,
      partyId: row.party_id,
      partyName: row.party_name,
      partyKind: row.party_kind,
      linkedBy: row.linked_by,
      agreementsInForce: row.in_force,
    });
  }
  return out;
}

/** A party "link to customer" may name: role customer, either kind (orgs first, then people). */
export interface CustomerPartyOption {
  id: string;
  name: string;
  kind: PartyKind;
}

export async function customerPartyOptions(ex: Executor): Promise<CustomerPartyOption[]> {
  const r = await exec<{ id: string; name: string; kind: PartyKind }>(
    ex,
    `select id::text as id, display_name as name, kind from farm.parties
      where 'customer' = any(roles)
      order by (kind <> 'org'), lower(display_name), id`,
  );
  return r.rows;
}

export type LinkOrgResult =
  | { status: 'linked'; partyName: string }
  | { status: 'already_linked'; partyName: string }
  | { status: 'not_customer' };

/**
 * Link a Deere org to a customer party (the ('deere', 'party', <org>, <org>) ref), only while
 * the org resolves to no party: an existing link (or a client party its farms share) stays, so
 * a link the fields sync relies on is never re-pointed from here.
 */
export async function linkDeereOrgToParty(
  ex: Executor,
  orgId: string,
  partyId: string,
): Promise<LinkOrgResult> {
  const party = await exec<{ name: string }>(
    ex,
    `select display_name as name from farm.parties where id = $1::uuid and 'customer' = any(roles)`,
    [partyId],
  );
  const name = party.rows[0]?.name;
  if (!name) return { status: 'not_customer' };
  const existing = (await deereOrgParties(ex, [orgId])).get(orgId);
  if (existing) return { status: 'already_linked', partyName: existing.partyName };
  await upsertExternalRef(ex, externalRef('deere', 'party', orgId, orgId), partyId);
  return { status: 'linked', partyName: name };
}

// ---------------------------------------------------------------------------------------------
// Agreements per party
// ---------------------------------------------------------------------------------------------

export interface AgreementRow {
  id: string;
  partyId: string;
  signedOn: string;
  documentKey: string | null;
  permittedUses: PermittedUse[];
  revokedOn: string | null;
  notes: string | null;
  /** Who recorded it (the app user's name), when known. */
  createdByName: string | null;
  source: string;
  createdAt: Date;
}

interface AgreementDbRow {
  id: string;
  party_id: string;
  signed_on: string;
  document_key: string | null;
  permitted_uses: PermittedUse[];
  revoked_on: string | null;
  notes: string | null;
  created_by_name: string | null;
  source: string;
  created_at: unknown;
}

const toAgreement = (r: AgreementDbRow): AgreementRow => ({
  id: r.id,
  partyId: r.party_id,
  signedOn: r.signed_on,
  documentKey: r.document_key,
  permittedUses: r.permitted_uses,
  revokedOn: r.revoked_on,
  notes: r.notes,
  createdByName: r.created_by_name,
  source: r.source,
  createdAt: toDate(r.created_at) as Date,
});

const AGREEMENT_COLUMNS = `
  a.id::text as id, a.party_id::text as party_id, a.signed_on::text as signed_on, a.document_key,
  a.permitted_uses, a.revoked_on::text as revoked_on, a.notes, p.display_name as created_by_name,
  a.source, a.created_at`;

/** A party's agreements: in force first, then newest signed first. */
export async function listAgreements(ex: Executor, partyId: string): Promise<AgreementRow[]> {
  const r = await exec<AgreementDbRow>(
    ex,
    `select ${AGREEMENT_COLUMNS}
       from farm.data_rights_agreements a
       left join farm.app_users u on u.id = a.created_by
       left join farm.parties p on p.id = u.party_id
      where a.party_id = $1::uuid
      order by (a.revoked_on is not null), a.signed_on desc, a.created_at desc, a.id`,
    [partyId],
  );
  return r.rows.map(toAgreement);
}

export async function getAgreement(ex: Executor, id: string): Promise<AgreementRow | null> {
  const r = await exec<AgreementDbRow>(
    ex,
    `select ${AGREEMENT_COLUMNS}
       from farm.data_rights_agreements a
       left join farm.app_users u on u.id = a.created_by
       left join farm.parties p on p.id = u.party_id
      where a.id = $1::uuid`,
    [id],
  );
  return r.rows[0] ? toAgreement(r.rows[0]) : null;
}

export type RecordAgreementResult =
  | { status: 'recorded'; id: string }
  | { status: 'not_customer' }
  | { status: 'document_in_use' };

/**
 * Record an agreement for a customer party (checked: role customer). `documentKey` is a key in
 * the private `uploads` bucket the caller has checked belongs to this party and exists; one
 * document backs one agreement.
 */
export async function recordAgreement(
  ex: Executor,
  input: AgreementInput & { partyId: string; documentKey: string | null },
  actor: { appUserId: string | null },
): Promise<RecordAgreementResult> {
  const party = await exec(
    ex,
    `select 1 from farm.parties where id = $1::uuid and 'customer' = any(roles)`,
    [input.partyId],
  );
  if (party.rowCount === 0) return { status: 'not_customer' };
  if (input.documentKey) {
    const used = await exec(
      ex,
      'select 1 from farm.data_rights_agreements where document_key = $1 limit 1',
      [input.documentKey],
    );
    if (used.rowCount > 0) return { status: 'document_in_use' };
  }
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.data_rights_agreements
       (party_id, signed_on, document_key, permitted_uses, notes, created_by, source)
     values ($1::uuid, $2::date, $3, $4::text[], $5,
             (select id from farm.app_users where id = $6::uuid), 'app')
     returning id::text as id`,
    [
      input.partyId,
      input.signedOn,
      input.documentKey,
      input.permittedUses,
      input.notes,
      actor.appUserId,
    ],
  );
  return { status: 'recorded', id: r.rows[0]?.id as string };
}

export type RevokeAgreementResult =
  | { status: 'revoked' }
  | { status: 'not_found' }
  | { status: 'already_revoked' };

/** Revoke one of a party's agreements as of `revokedOn` (validated by the caller). */
export async function revokeAgreement(
  ex: Executor,
  input: { id: string; partyId: string; revokedOn: string },
): Promise<RevokeAgreementResult> {
  const r = await exec(
    ex,
    `update farm.data_rights_agreements set revoked_on = $3::date, updated_at = now()
      where id = $1::uuid and party_id = $2::uuid and revoked_on is null`,
    [input.id, input.partyId, input.revokedOn],
  );
  if (r.rowCount > 0) return { status: 'revoked' };
  const found = await exec(
    ex,
    'select 1 from farm.data_rights_agreements where id = $1::uuid and party_id = $2::uuid',
    [input.id, input.partyId],
  );
  return found.rowCount > 0 ? { status: 'already_revoked' } : { status: 'not_found' };
}

/** The Deere orgs a party is the customer of (the gate's resolution), for its agreements card. */
export async function deereOrgsOfParty(ex: Executor, partyId: string): Promise<string[]> {
  const r = await exec<{ org_id: string }>(
    ex,
    `with ${ORG_PARTIES_CTE}
     select org_id from org_parties where party_id = $1::uuid order by org_id`,
    [partyId],
  );
  return r.rows.map((row) => row.org_id);
}
