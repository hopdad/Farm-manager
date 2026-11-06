/**
 * Data-rights agreements and the gate's loader against a real database (D17,
 * docs/contracts-2a.md §4.4; done-when §11.4 "the loader against seeded agreements and refs"):
 *
 *  - the org -> party resolution is `customerOrgParty`'s, read-only: the ('deere', 'party',
 *    org, org) ref when its party exists, else the one client party every farm of the org
 *    shares; nothing for two parties, an unassigned farm, or no refs; the same answer
 *    `customerOrgParty` gives (checked in a rolled-back transaction), and nothing written;
 *  - `loadOrgReadRights` / `agreedDeereOrgIds`: orgs whose party has an agreement in force; a
 *    revoked one doesn't count, another party's doesn't either;
 *  - "link to customer": customers only, an org that resolves already is never re-pointed;
 *  - record (role customer, created_by, one document per agreement), list (in force first),
 *    revoke (once, own party only).
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { loadOrgReadRights } from '../../connectors/deere/rights';
import { externalRef } from '../../connectors/types';
import { deterministicId } from '../../domain/ids';
import { setupTestDb } from '../../test/db';
import { upsertExternalRef } from '../external-refs';
import {
  agreedDeereOrgIds,
  customerPartyOptions,
  deereOrgParties,
  deereOrgsOfParty,
  getAgreement,
  linkDeereOrgToParty,
  listAgreements,
  recordAgreement,
  revokeAgreement,
} from './agreements';
import { customerOrgParty } from './deere-fields';

const t = setupTestDb(import.meta.url);
const id = (k: string) => deterministicId('test', k);

const P = {
  refCo: id('party:ref-co'),
  farmsCo: id('party:farms-co'),
  splitA: id('party:split-a'),
  splitB: id('party:split-b'),
  gone: id('party:gone'),
  person: id('party:person-customer'),
  landlord: id('party:landlord'),
  manager: id('party:manager'),
};
const MANAGER_USER = id('user:manager');

async function party(pid: string, name: string, kind: 'org' | 'person', roles: string[]) {
  await t().pool.query(
    `insert into farm.parties (id, kind, display_name, roles, source, source_id)
     values ($1::uuid, $2, $3, $4::text[], 'test', $5)`,
    [pid, kind, name, roles, pid],
  );
}

async function farm(key: string, org: string, client: string | null) {
  const fid = id(`farm:${key}`);
  await t().pool.query(
    `insert into farm.farms (id, name, client_party_id, source, source_id)
     values ($1, $2, $3, 'test', $2)`,
    [fid, key, client],
  );
  await upsertExternalRef(t().pool, externalRef('deere', 'farm', `deere-${key}`, org), fid);
}

async function agreement(pid: string, signedOn: string, revokedOn: string | null = null) {
  await t().pool.query(
    `insert into farm.data_rights_agreements (party_id, signed_on, permitted_uses, revoked_on)
     values ($1, $2, '{billing}', $3)`,
    [pid, signedOn, revokedOn],
  );
}

const count = async (table: string) =>
  (await t().pool.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n ?? 0;

beforeAll(async () => {
  await party(P.refCo, 'Ref Co', 'org', ['customer']);
  await party(P.farmsCo, 'Farms Co', 'org', ['customer']);
  await party(P.splitA, 'Split A', 'org', ['customer']);
  await party(P.splitB, 'Split B', 'org', ['customer']);
  await party(P.gone, 'Gone Co', 'org', ['customer']);
  await party(P.person, 'Pat Person', 'person', ['customer']);
  await party(P.landlord, 'Lana Landlord', 'person', ['landlord']);
  await party(P.manager, 'Mona Manager', 'person', ['crew']);
  await t().pool.query(
    `insert into farm.app_users (id, party_id, role, source, source_id)
     values ($1, $2, 'manager', 'test', 'manager')`,
    [MANAGER_USER, P.manager],
  );

  // org-ref: linked by the ('deere','party',org,org) ref (its farms name another party: the ref wins).
  await upsertExternalRef(t().pool, externalRef('deere', 'party', 'org-ref', 'org-ref'), P.refCo);
  await farm('ref-1', 'org-ref', P.splitA);
  // org-farms: no ref; both farms share Farms Co.
  await farm('farms-1', 'org-farms', P.farmsCo);
  await farm('farms-2', 'org-farms', P.farmsCo);
  // org-split: two farms, two parties: none.
  await farm('split-1', 'org-split', P.splitA);
  await farm('split-2', 'org-split', P.splitB);
  // org-mixed: one farm of Farms Co, one unassigned: none.
  await farm('mixed-1', 'org-mixed', P.farmsCo);
  await farm('mixed-2', 'org-mixed', null);
  // org-stale: its ref points at a party that no longer exists; its farm names Split B.
  await upsertExternalRef(
    t().pool,
    externalRef('deere', 'party', 'org-stale', 'org-stale'),
    id('party:deleted'),
  );
  await farm('stale-1', 'org-stale', P.splitB);
  // org-person: a person customer linked by ref.
  await upsertExternalRef(
    t().pool,
    externalRef('deere', 'party', 'org-person', 'org-person'),
    P.person,
  );
  // A party ref of a Deere client (external id != org): never an org link.
  await upsertExternalRef(
    t().pool,
    externalRef('deere', 'party', 'client-77', 'org-none'),
    P.refCo,
  );
});

describe("the org -> party resolution (read-only, customerOrgParty's rule)", () => {
  const ORGS = ['org-ref', 'org-farms', 'org-split', 'org-mixed', 'org-stale', 'org-person'];

  test('ref first, else the one client party every farm shares', async () => {
    const m = await deereOrgParties(t().pool, [...ORGS, 'org-none', 'org-unknown']);
    expect(Object.fromEntries([...m].map(([org, p]) => [org, [p.partyName, p.linkedBy]]))).toEqual({
      'org-ref': ['Ref Co', 'ref'],
      'org-farms': ['Farms Co', 'farms'],
      'org-stale': ['Split B', 'farms'],
      'org-person': ['Pat Person', 'ref'],
    });
    expect(m.get('org-person')?.partyKind).toBe('person');
    expect(await deereOrgParties(t().pool, [])).toEqual(new Map());
  });

  test('the same party customerOrgParty resolves (which writes; rolled back here)', async () => {
    const resolved = await deereOrgParties(t().pool, ORGS);
    const client = await t().pool.connect();
    try {
      await client.query('begin');
      for (const org of ORGS) {
        const got = await customerOrgParty(client, org, null);
        const mine = resolved.get(org)?.partyId;
        if (mine) expect(got).toBe(mine);
        else expect(Object.values(P)).not.toContain(got); // it created a new party instead
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  test('loadOrgReadRights: agreements in force only; reads, never writes', async () => {
    const refs = await count('ingest.external_refs');
    const parties = await count('farm.parties');
    expect(await agreedDeereOrgIds(t().pool)).toEqual(new Set());
    await agreement(P.refCo, '2026-01-01');
    await agreement(P.farmsCo, '2026-01-01', '2026-06-01'); // revoked
    await agreement(P.splitA, '2026-01-01'); // org-split resolves to nobody: still not read
    await agreement(P.landlord, '2026-01-01'); // not linked to any org
    const rights = await loadOrgReadRights(t().pool, 'live', 'org-home');
    expect(rights).toEqual({
      mode: 'live',
      homeOrgId: 'org-home',
      agreedOrgIds: new Set(['org-ref']),
    });
    await agreement(P.farmsCo, '2026-07-01');
    expect(await agreedDeereOrgIds(t().pool)).toEqual(new Set(['org-ref', 'org-farms']));
    expect(
      (await deereOrgParties(t().pool, ['org-farms'])).get('org-farms')?.agreementsInForce,
    ).toBe(1);
    expect(await count('ingest.external_refs')).toBe(refs);
    expect(await count('farm.parties')).toBe(parties);
  });

  test("a party's Deere orgs", async () => {
    expect(await deereOrgsOfParty(t().pool, P.farmsCo)).toEqual(['org-farms']);
    expect(await deereOrgsOfParty(t().pool, P.splitB)).toEqual(['org-stale']);
    expect(await deereOrgsOfParty(t().pool, P.landlord)).toEqual([]);
  });
});

describe('link to customer', () => {
  test('customers only; then the ref, which the gate and customerOrgParty both read', async () => {
    expect(await linkDeereOrgToParty(t().pool, 'org-new', P.landlord)).toEqual({
      status: 'not_customer',
    });
    expect(await linkDeereOrgToParty(t().pool, 'org-new', id('party:nobody'))).toEqual({
      status: 'not_customer',
    });
    expect(await linkDeereOrgToParty(t().pool, 'org-new', P.splitA)).toEqual({
      status: 'linked',
      partyName: 'Split A',
    });
    expect((await deereOrgParties(t().pool, ['org-new'])).get('org-new')).toMatchObject({
      partyId: P.splitA,
      linkedBy: 'ref',
    });
    expect(await agreedDeereOrgIds(t().pool)).toContain('org-new'); // Split A has one on file
  });

  test('an org that resolves already is never re-pointed', async () => {
    expect(await linkDeereOrgToParty(t().pool, 'org-new', P.splitB)).toEqual({
      status: 'already_linked',
      partyName: 'Split A',
    });
    expect(await linkDeereOrgToParty(t().pool, 'org-farms', P.splitB)).toEqual({
      status: 'already_linked',
      partyName: 'Farms Co',
    });
    expect((await deereOrgParties(t().pool, ['org-farms'])).get('org-farms')?.linkedBy).toBe(
      'farms',
    );
  });

  test('the options: customers of either kind, orgs first, by name', async () => {
    const names = (await customerPartyOptions(t().pool)).map((c) => `${c.kind}:${c.name}`);
    expect(names).toEqual([
      'org:Farms Co',
      'org:Gone Co',
      'org:Ref Co',
      'org:Split A',
      'org:Split B',
      'person:Pat Person',
    ]);
  });
});

describe('agreements of a party', () => {
  test('record: customers only, with who recorded it; one document backs one agreement', async () => {
    const input = {
      signedOn: '2026-10-01',
      permittedUses: ['billing', 'agronomy'] as ('billing' | 'agronomy')[],
      notes: 'paper copy in the office',
    };
    expect(
      await recordAgreement(
        t().pool,
        { ...input, partyId: P.landlord, documentKey: null },
        { appUserId: MANAGER_USER },
      ),
    ).toEqual({ status: 'not_customer' });
    const key = `agreements/${P.gone}/0b3f8f1e-5d43-4a7e-9a55-6c2c1f9f0a11.pdf`;
    const r = await recordAgreement(
      t().pool,
      { ...input, partyId: P.gone, documentKey: key },
      { appUserId: MANAGER_USER },
    );
    expect(r.status).toBe('recorded');
    const a = r.status === 'recorded' ? await getAgreement(t().pool, r.id) : null;
    expect(a).toMatchObject({
      partyId: P.gone,
      signedOn: '2026-10-01',
      documentKey: key,
      permittedUses: ['billing', 'agronomy'],
      revokedOn: null,
      notes: 'paper copy in the office',
      createdByName: 'Mona Manager',
      source: 'app',
    });
    expect(
      await recordAgreement(
        t().pool,
        { ...input, partyId: P.gone, documentKey: key },
        { appUserId: null },
      ),
    ).toEqual({ status: 'document_in_use' });
    // An unknown app user (a stale session) records with no author rather than failing.
    const anon = await recordAgreement(
      t().pool,
      { ...input, signedOn: '2026-10-15', partyId: P.gone, documentKey: null },
      { appUserId: id('user:deleted') },
    );
    expect(anon.status).toBe('recorded');
  });

  test('list in force first, newest signed first; revoke once, own party only', async () => {
    const before = await listAgreements(t().pool, P.gone);
    expect(before.map((a) => a.signedOn)).toEqual(['2026-10-15', '2026-10-01']);
    const [newest, older] = before as [(typeof before)[0], (typeof before)[0]];
    expect(newest.createdByName).toBeNull();
    expect(
      await revokeAgreement(t().pool, { id: newest.id, partyId: P.refCo, revokedOn: '2026-11-01' }),
    ).toEqual({ status: 'not_found' });
    expect(
      await revokeAgreement(t().pool, { id: newest.id, partyId: P.gone, revokedOn: '2026-11-01' }),
    ).toEqual({ status: 'revoked' });
    expect(
      await revokeAgreement(t().pool, { id: newest.id, partyId: P.gone, revokedOn: '2026-11-02' }),
    ).toEqual({ status: 'already_revoked' });
    const after = await listAgreements(t().pool, P.gone);
    expect(after.map((a) => [a.signedOn, a.revokedOn])).toEqual([
      ['2026-10-01', null],
      ['2026-10-15', '2026-11-01'],
    ]);
    expect(after[0]?.id).toBe(older.id);
    // The table's own CHECK: never revoked before it was signed.
    await expect(
      revokeAgreement(t().pool, { id: older.id, partyId: P.gone, revokedOn: '2026-09-01' }),
    ).rejects.toThrow(/data_rights_agreements_revoked_on_check/);
  });
});
