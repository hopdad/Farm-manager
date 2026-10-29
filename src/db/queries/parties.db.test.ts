/** Parties: forms, links to fields and farms, CSV import, delete guards. */
import { describe, expect, test } from 'vitest';
import { parsePartiesCsv } from '../../../tools/import/parties-csv';
import { setupTestDb } from '../../test/db';
import {
  createParty,
  deleteParty,
  getParty,
  importParties,
  listParties,
  setFarmClient,
  setFieldLandlord,
  updateParty,
  validateParty,
} from './parties';

const t = setupTestDb(import.meta.url);
const actor = { appUserId: null, displayName: 'Test' };

function input(raw: Parameters<typeof validateParty>[0]) {
  const v = validateParty(raw);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.value;
}

async function farmWithField(name: string) {
  const { pool } = t();
  const fa = await pool.query<{ id: string }>(
    `insert into farm.farms (name) values ($1) returning id`,
    [`${name} farm`],
  );
  const f = await pool.query<{ id: string }>(
    `insert into farm.fields (farm_id, name, tenure) values ($1, $2, 'cash_rent') returning id`,
    [fa.rows[0]?.id, name],
  );
  return { farmId: fa.rows[0]?.id as string, fieldId: f.rows[0]?.id as string };
}

async function seq(): Promise<number> {
  const r = await t().pool.query<{ seq: string }>(
    `select seq from app.topic_seq where topic = 'fields'`,
  );
  return Number(r.rows[0]?.seq ?? 0);
}

describe('parties', () => {
  test('create, link as landlord and customer, edit (publishes), refuse delete while linked', async () => {
    const { pool } = t();
    const id = await createParty(
      pool,
      input({ displayName: 'Faye Tillman', roles: 'landlord', phone: '517-555-0100' }),
      actor,
    );
    const { farmId, fieldId } = await farmWithField('Tillman 80');
    await setFieldLandlord(pool, { fieldId, partyId: id, actor });
    await setFarmClient(pool, { farmId, partyId: id, actor });
    const p = await getParty(pool, id);
    expect(p).toMatchObject({
      displayName: 'Faye Tillman',
      roles: ['landlord'],
      source: 'app',
      landlordFields: [{ fieldId, name: 'Tillman 80' }],
      customerFarms: [{ farmId, fieldCount: 1 }],
      appUserRole: null,
    });
    const before = await seq();
    await updateParty(pool, {
      id,
      input: input({
        displayName: 'Faye Tillman',
        roles: 'landlord;customer',
        phone: '517-555-0199',
      }),
      version: p?.version ?? null,
      actor,
    });
    expect(await seq()).toBeGreaterThan(before);
    await expect(
      updateParty(pool, {
        id,
        input: input({ displayName: 'Faye T' }),
        version: p?.version ?? null,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    await expect(deleteParty(pool, id, actor)).rejects.toThrow(
      /landlord of 1 field.*customer of 1 farm/,
    );
    await setFieldLandlord(pool, { fieldId, partyId: null, actor });
    await setFarmClient(pool, { farmId, partyId: null, actor });
    await deleteParty(pool, id, actor);
    expect(await getParty(pool, id)).toBeNull();
  });

  test('people work for organizations; an organization with members stays one', async () => {
    const { pool } = t();
    const org = await createParty(pool, input({ displayName: 'Bend LLC', kind: 'org' }), actor);
    const person = await createParty(pool, input({ displayName: 'Joan', orgId: org }), actor);
    expect((await getParty(pool, person))?.orgName).toBe('Bend LLC');
    await expect(
      createParty(pool, input({ displayName: 'Kid', orgId: person }), actor),
    ).rejects.toThrow(/must be an organization/);
    const o = await getParty(pool, org);
    await expect(
      updateParty(pool, {
        id: org,
        input: input({ displayName: 'Bend LLC' }),
        version: o?.version ?? null,
        actor,
      }),
    ).rejects.toThrow(/must stay an organization/);
    const listed = await listParties(pool, { q: 'bend' });
    expect(listed.map((x) => x.displayName)).toEqual(['Bend LLC']);
  });

  test('CSV import: inserts, then merges into its own rows; orgs from the file; all or nothing', async () => {
    const { pool } = t();
    await pool.query(
      `insert into farm.parties (kind, display_name, roles, source, source_id) values ('person', 'Demo Dan', '{crew}', 'demo', 'p:dan')`,
    );
    const csv = [
      'display_name,kind,roles,phone,email,address,notes,org',
      'Joan Albrecht,person,landlord,517-555-0188,,,,River LLC',
      'River LLC,org,landlord,,,,,',
      'Demo Dan,person,crew,,,,,',
    ].join('\n');
    const first = await importParties(pool, parsePartiesCsv(csv).rows);
    expect(first.rows.map((r) => r.action)).toEqual(['insert', 'insert', 'insert']);
    const joan = await getParty(pool, first.rows[0]?.partyId as string);
    expect(joan).toMatchObject({ orgName: 'River LLC', source: 'import' });
    // A second Dan: the demo row is not merged into.
    expect((await listParties(pool, { q: 'demo dan' })).length).toBe(2);

    const again = await importParties(pool, parsePartiesCsv(csv).rows);
    expect(again.rows.map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    const more = await importParties(
      pool,
      parsePartiesCsv('display_name,roles,email\nJoan Albrecht,customer,joan@example.com\n').rows,
    );
    expect(more.rows[0]?.action).toBe('update');
    const merged = await getParty(pool, joan?.id as string);
    expect(merged).toMatchObject({
      roles: ['landlord', 'customer'],
      phone: '517-555-0188',
      email: 'joan@example.com',
      orgName: 'River LLC',
    });

    const bad = await importParties(
      pool,
      parsePartiesCsv('display_name,org\nNew Person,Nowhere Inc\nOther,\n').rows,
    );
    expect(bad.written).toBe(false);
    expect(bad.rows.map((r) => r.action)).toEqual(['error', 'blocked']);
    expect((await listParties(pool, { q: 'other' })).length).toBe(0);

    const dry = await importParties(pool, parsePartiesCsv('display_name\nDry Person\n').rows, {
      dryRun: true,
    });
    expect(dry).toMatchObject({ written: false, counts: { insert: 1 } });
    expect((await listParties(pool, { q: 'dry person' })).length).toBe(0);
  });
});
