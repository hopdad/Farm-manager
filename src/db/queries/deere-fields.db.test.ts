/**
 * The deere.fields writers against a real database (docs/contracts-1f.md §5.4, §5.7, decisions 7
 * and 8; done-when §11.1), on the demo farm as the seed writes it (seedSimFarm): field match
 * order (ref, then deere_field_id with the ref written, else created with tenure `unknown` in its
 * Deere farm), the columns the sync owns vs the hand-entered overlays, the owning org, the D6
 * boundary versions (same geometry = nothing, an edit = a version, A → B → A = `#1`, the ref
 * re-pointed, a sharing org's boundary only a ref), the customer party of a customer org's farm,
 * no home org = nothing created, and the Equipment API machines with the unmappable kinds.
 */
import type { MultiPolygon } from 'geojson';
import { beforeAll, describe, expect, test } from 'vitest';
import type { DeereFieldItem, DeereMachineItem } from '../../connectors/deere/fields/mapper';
import { listenAppEvents, seedSimFarm } from '../../connectors/testkit';
import { externalRef, type NormalizedBoundary, type NormalizedField } from '../../connectors/types';
import { deterministicId } from '../../domain/ids';
import { buildDemoFarm } from '../../sim/farm/build';
import { SIM_DEERE_HOME_ORG } from '../../sim/types';
import { setupTestDb } from '../../test/db';
import { resolveExternalRef } from '../external-refs';
import {
  customerOrgParty,
  DEERE_DEFAULT_FARM,
  upsertDeereField,
  upsertDeereMachines,
  writeUnmappedKinds,
} from './deere-fields';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const HOME = SIM_DEERE_HOME_ORG;
const unitOf = (fieldId: string) => {
  const f = farm.fields.find((x) => x.id === fieldId);
  return farm.farms.find((u) => u.id === f?.farmId);
};
const homeFields = farm.fields.filter(
  (f) => unitOf(f.id)?.deereOrgId === HOME && !unitOf(f.id)?.clientPartyId,
);
const shared = farm.fields.find((f) => f.sharedWith) as (typeof farm.fields)[number];
const halvorsen = farm.fields.find(
  (f) => unitOf(f.id)?.deereOrgId === 'org-customer-1',
) as (typeof farm.fields)[number];

/** A square ~400 m on a side whose south-west corner is at (lng, lat). */
function square(lng: number, lat: number, d = 0.005): MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [lng, lat],
          [lng + d, lat],
          [lng + d, lat + d * 0.75],
          [lng, lat + d * 0.75],
          [lng, lat],
        ],
      ],
    ],
  };
}

function boundary(
  org: string,
  fieldId: string,
  id: string,
  geom: MultiPolygon,
): NormalizedBoundary {
  return {
    source: 'deere',
    sourceOrg: org,
    externalId: id,
    fieldExternalId: fieldId,
    name: `Boundary ${id}`,
    geom,
    areaAc: null,
    active: true,
    archived: false,
    modifiedAt: null,
  };
}

function item(
  f: Partial<NormalizedField> & { sourceOrg: string; externalId: string },
  home: string | null = HOME,
): DeereFieldItem {
  return {
    field: {
      source: 'deere',
      name: f.name ?? 'Field',
      farm: null,
      client: null,
      archived: false,
      boundary: null,
      modifiedAt: null,
      ...f,
    },
    orgName: f.sourceOrg === HOME ? 'Home operation' : `Org ${f.sourceOrg}`,
    homeOrgId: home,
  };
}

const write = (i: DeereFieldItem) => t().db.transaction((tx) => upsertDeereField(tx, i));

async function versions(fieldId: string) {
  const r = await t().pool.query<{
    id: string;
    source: string;
    source_id: string | null;
    source_ref: string | null;
    open: boolean;
  }>(
    `select id::text, source, source_id, source_ref, upper_inf(valid) as open
       from farm.field_boundaries where field_id = $1 order by lower(valid), id`,
    [fieldId],
  );
  return r.rows;
}

async function fieldRow(id: string) {
  const r = await t().pool.query(
    `select name, tenure, deere_field_id, active, farm_id::text as farm_id, county_fips,
            landlord_party_id::text as landlord, notes, updated_at, source, source_id
       from farm.fields where id = $1`,
    [id],
  );
  return r.rows[0];
}

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
});

describe('field matching', () => {
  test('by external ref: the demo field keeps its id; owned columns only change when they differ', async () => {
    const f = homeFields[0] as (typeof farm.fields)[number];
    const before = await fieldRow(f.id);
    const r = await write(item({ sourceOrg: HOME, externalId: f.deereFieldId, name: f.name }));
    expect(r).toMatchObject({ fieldId: f.id, action: 'matched_ref', parts: [] });
    expect((await fieldRow(f.id)).updated_at).toEqual(before.updated_at);
  });

  test('by deere_field_id (an Ops Center import): matched and the ref written, never duplicated', async () => {
    const farmId = (
      await t().pool.query<{ id: string }>(
        `insert into farm.farms (name, source) values ('Imported farm', 'import') returning id::text`,
      )
    ).rows[0]?.id as string;
    const fieldId = (
      await t().pool.query<{ id: string }>(
        `insert into farm.fields (farm_id, name, tenure, deere_field_id, source)
         values ($1, 'Imported 40', 'owned', 'deere-imported-1', 'import') returning id::text`,
        [farmId],
      )
    ).rows[0]?.id as string;
    const r = await write(
      item({ sourceOrg: HOME, externalId: 'deere-imported-1', name: 'Imported 40' }),
    );
    expect(r).toMatchObject({ fieldId, action: 'matched_deere_id' });
    expect(
      await resolveExternalRef(t().pool, externalRef('deere', 'field', 'deere-imported-1', HOME)),
    ).toBe(fieldId);
    const again = await write(
      item({ sourceOrg: HOME, externalId: 'deere-imported-1', name: 'Imported 40' }),
    );
    expect(again.action).toBe('matched_ref');
  });

  test('else created: deterministic id, tenure unknown, in its Deere farm (matched by ref)', async () => {
    const unit = unitOf(homeFields[0]?.id as string);
    const geom = square(-83.95, 41.995);
    const r = await write(
      item({
        sourceOrg: HOME,
        externalId: 'deere-new-1',
        name: 'New Ground 80',
        farm: { externalId: unit?.deereFarmId as string, name: unit?.name as string },
        boundary: boundary(HOME, 'deere-new-1', 'deere-new-b1', geom),
      }),
    );
    const id = deterministicId('deere', 'deere-new-1');
    expect(r).toMatchObject({ fieldId: id, action: 'created', boundary: 'version' });
    expect(r.parts).toEqual(['boundary', 'identity']);
    expect(await fieldRow(id)).toMatchObject({
      name: 'New Ground 80',
      tenure: 'unknown',
      deere_field_id: 'deere-new-1',
      active: true,
      farm_id: unit?.id,
      source: 'deere',
      source_id: 'deere-new-1',
    });
    const v = await versions(id);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      source: 'deere',
      open: true,
      source_ref: 'Boundary deere-new-b1',
    });
    expect(v[0]?.source_id).toMatch(/^deere-new-b1@[0-9a-f]{8}$/);
    expect(v[0]?.id).toBe(deterministicId('deere', v[0]?.source_id as string));
  });

  test('a new Deere farm is created (deere_farm_id, deterministic id); no farm at all = "Home farm"', async () => {
    await write(
      item({
        sourceOrg: HOME,
        externalId: 'deere-new-2',
        name: 'Far 40',
        farm: { externalId: 'deere-farm-x', name: 'Far Farm' },
      }),
    );
    const f2 = await fieldRow(deterministicId('deere', 'deere-new-2'));
    expect(f2.farm_id).toBe(deterministicId('deere', 'deere-farm-x'));
    const farmRow = await t().pool.query(
      `select name, deere_farm_id, client_party_id, source from farm.farms where id = $1`,
      [f2.farm_id],
    );
    expect(farmRow.rows[0]).toEqual({
      name: 'Far Farm',
      deere_farm_id: 'deere-farm-x',
      client_party_id: null,
      source: 'deere',
    });
    await write(item({ sourceOrg: HOME, externalId: 'deere-new-3', name: 'Orphan 20' }));
    const f3 = await fieldRow(deterministicId('deere', 'deere-new-3'));
    const home = await t().pool.query(`select name from farm.farms where id = $1`, [f3.farm_id]);
    expect(home.rows[0]?.name).toBe(DEERE_DEFAULT_FARM);
  });

  test('an archived field the app never had is not created', async () => {
    const r = await write(item({ sourceOrg: HOME, externalId: 'deere-gone', archived: true }));
    expect(r).toMatchObject({ action: 'skipped', reason: 'archived', fieldId: null });
  });
});

describe('owned columns and overlays', () => {
  test('a rename and an archive from the owning org; tenure, landlord, county and notes untouched', async () => {
    const f = homeFields[1] as (typeof farm.fields)[number];
    const landlord = farm.parties.find((p) => p.roles.includes('landlord'))?.id;
    await t().pool.query(
      `update farm.fields set tenure = 'cash_rent', landlord_party_id = $2, notes = 'gate 1234',
              county_fips = '26115' where id = $1`,
      [f.id, landlord],
    );
    const r = await write(
      item({ sourceOrg: HOME, externalId: f.deereFieldId, name: 'Renamed in Deere' }),
    );
    expect(r.parts).toEqual(['identity']);
    expect(await fieldRow(f.id)).toMatchObject({
      name: 'Renamed in Deere',
      tenure: 'cash_rent',
      landlord,
      notes: 'gate 1234',
      county_fips: '26115',
      active: true,
    });
    await write(
      item({
        sourceOrg: HOME,
        externalId: f.deereFieldId,
        name: 'Renamed in Deere',
        archived: true,
      }),
    );
    expect((await fieldRow(f.id)).active).toBe(false);
    // Un-archived in Deere: never set active again; a hidden field is left as it is.
    const back = await write(
      item({ sourceOrg: HOME, externalId: f.deereFieldId, name: 'Back again' }),
    );
    expect(back.parts).toEqual([]);
    expect(await fieldRow(f.id)).toMatchObject({ active: false, name: 'Renamed in Deere' });
  });

  test("a sharing org's copy never renames the field", async () => {
    const sharing = shared.sharedWith as { deereOrgId: string; deereFieldId: string };
    const r = await write(
      item({ sourceOrg: sharing.deereOrgId, externalId: sharing.deereFieldId, name: 'Their name' }),
    );
    expect(r).toMatchObject({ fieldId: shared.id, action: 'matched_ref', parts: [] });
    expect((await fieldRow(shared.id)).name).toBe(shared.name);
  });
});

describe('the Deere boundary writer (decision 7)', () => {
  const f = homeFields[2] as (typeof farm.fields)[number];
  const A = f.boundary;
  const B = square(-84.2, 41.75);
  const own = (id: string, geom: MultiPolygon) =>
    item({
      sourceOrg: HOME,
      externalId: f.deereFieldId,
      name: f.name,
      boundary: boundary(HOME, f.deereFieldId, id, geom),
    });

  test('the owning org writes its boundary: the demo version becomes history, the ref moves', async () => {
    const r = await write(own(f.deereBoundaryId, A));
    expect(r).toMatchObject({ boundary: 'version', parts: ['boundary'] });
    const v = await versions(f.id);
    expect(v.map((x) => [x.source, x.open])).toEqual([
      ['demo', false],
      ['deere', true],
    ]);
    expect(v[0]?.id).toBe(f.boundaryId);
    expect(
      await resolveExternalRef(t().pool, externalRef('deere', 'boundary', f.deereBoundaryId, HOME)),
    ).toBe(v[1]?.id);
  });

  test('same geometry again: no version; another Deere boundary id with that geometry: only its ref', async () => {
    expect((await write(own(f.deereBoundaryId, A))).boundary).toBe('unchanged');
    expect((await write(own('other-id', A))).boundary).toBe('unchanged');
    const v = await versions(f.id);
    expect(v).toHaveLength(2);
    expect(
      await resolveExternalRef(t().pool, externalRef('deere', 'boundary', 'other-id', HOME)),
    ).toBe(v[1]?.id);
  });

  test('an edit is a new version; going back to the first geometry is a #1 version', async () => {
    expect((await write(own(f.deereBoundaryId, B))).boundary).toBe('version');
    expect((await write(own(f.deereBoundaryId, A))).boundary).toBe('version');
    const v = await versions(f.id);
    expect(v.map((x) => x.source)).toEqual(['demo', 'deere', 'deere', 'deere']);
    expect(v.filter((x) => x.open)).toHaveLength(1);
    const [, first, , back] = v;
    expect(back?.source_id).toBe(`${first?.source_id}#1`);
    expect(back?.id).toBe(deterministicId('deere', back?.source_id as string));
    expect(
      await resolveExternalRef(t().pool, externalRef('deere', 'boundary', f.deereBoundaryId, HOME)),
    ).toBe(back?.id);
    // A → B → A → B → A: #2.
    await write(own(f.deereBoundaryId, B));
    await write(own(f.deereBoundaryId, A));
    const again = await versions(f.id);
    expect(again.at(-1)?.source_id).toBe(`${first?.source_id}#2`);
  });

  test("a sharing org's boundary is only a ref, at the current version, and follows the owner's new versions", async () => {
    const sharing = shared.sharedWith as { deereOrgId: string; deereFieldId: string };
    const theirs = item({
      sourceOrg: sharing.deereOrgId,
      externalId: sharing.deereFieldId,
      name: 'Theirs',
      boundary: boundary(sharing.deereOrgId, sharing.deereFieldId, 'shared-b', square(-84.3, 41.7)),
    });
    expect((await write(theirs)).boundary).toBe('ref');
    let v = await versions(shared.id);
    expect(v.map((x) => x.source)).toEqual(['demo']);
    const ref = externalRef('deere', 'boundary', 'shared-b', sharing.deereOrgId);
    expect(await resolveExternalRef(t().pool, ref)).toBe(shared.boundaryId);
    // The owning org (the Juniper Hill farm is in the home org) writes its version: the sharing
    // org's ref follows the field's current version.
    const owner = item({
      sourceOrg: HOME,
      externalId: shared.deereFieldId,
      name: shared.name,
      boundary: boundary(HOME, shared.deereFieldId, shared.deereBoundaryId, shared.boundary),
    });
    expect((await write(owner)).boundary).toBe('version');
    v = await versions(shared.id);
    expect(v.map((x) => [x.source, x.open])).toEqual([
      ['demo', false],
      ['deere', true],
    ]);
    expect(await resolveExternalRef(t().pool, ref)).toBe(v[1]?.id);
  });

  test('a customer org owns the boundaries of its own farm (Halvorsen)', async () => {
    const r = await write(
      item({
        sourceOrg: 'org-customer-1',
        externalId: halvorsen.deereFieldId,
        name: halvorsen.name,
        boundary: boundary(
          'org-customer-1',
          halvorsen.deereFieldId,
          halvorsen.deereBoundaryId,
          halvorsen.boundary,
        ),
      }),
    );
    expect(r.boundary).toBe('version');
  });

  test('fields/updated is published with the parts that changed', async () => {
    const l = await listenAppEvents(t().appUrl);
    try {
      await write(own(f.deereBoundaryId, B));
      await l.settle();
      expect(l.of('fields', 'updated').map((m) => m.payload)).toContainEqual(
        expect.objectContaining({ fieldId: f.id, parts: ['boundary'] }),
      );
    } finally {
      await l.close();
    }
  });
});

describe('customer orgs and the home org (decision 8)', () => {
  test("a farm created in a customer org gets the party the org's matched farms share (the ref is written)", async () => {
    await write(
      item({
        sourceOrg: 'org-customer-1',
        externalId: 'halv-new-1',
        name: 'Halvorsen New 40',
        farm: { externalId: 'halv-farm-2', name: 'Halvorsen East' },
      }),
    );
    const f = await fieldRow(deterministicId('deere', 'halv-new-1'));
    const farmRow = await t().pool.query(
      `select client_party_id::text as p from farm.farms where id = $1`,
      [f.farm_id],
    );
    const halvorsenUnit = farm.farms.find((u) => u.deereOrgId === 'org-customer-1');
    expect(farmRow.rows[0]?.p).toBe(halvorsenUnit?.clientPartyId);
    expect(
      await resolveExternalRef(
        t().pool,
        externalRef('deere', 'party', 'org-customer-1', 'org-customer-1'),
      ),
    ).toBe(halvorsenUnit?.clientPartyId);
    expect(f.tenure).toBe('unknown');
  });

  test('an org with no matched farm gets a party created from it; a farmless field lands in the org farm', async () => {
    await write(item({ sourceOrg: 'org-customer-9', externalId: 'c9-f1', name: 'Nine 80' }));
    const f = await fieldRow(deterministicId('deere', 'c9-f1'));
    const farmRow = await t().pool.query(
      `select f.name, f.source_id, p.display_name, p.roles, p.kind, p.source, p.source_id as psid, p.id::text as pid
         from farm.farms f join farm.parties p on p.id = f.client_party_id where f.id = $1`,
      [f.farm_id],
    );
    expect(farmRow.rows[0]).toMatchObject({
      name: 'Org org-customer-9',
      source_id: 'org:org-customer-9',
      display_name: 'Org org-customer-9',
      roles: ['customer'],
      kind: 'org',
      source: 'deere',
      psid: 'org:org-customer-9',
      pid: deterministicId('deere', 'org:org-customer-9'),
    });
    // The next farm of that org finds the party through its ref.
    expect(await t().db.transaction((tx) => customerOrgParty(tx, 'org-customer-9', null))).toBe(
      deterministicId('deere', 'org:org-customer-9'),
    );
  });

  test("a home-org farm takes its Deere client's party (the customer of that name)", async () => {
    await write(
      item({
        sourceOrg: HOME,
        externalId: 'jh-new-1',
        name: 'Juniper New 40',
        farm: { externalId: 'jh-farm-2', name: 'Juniper East' },
        client: { externalId: 'jh-client', name: 'Juniper Hill Farms LLC' },
      }),
    );
    const f = await fieldRow(deterministicId('deere', 'jh-new-1'));
    const p = await t().pool.query(
      `select client_party_id::text as p from farm.farms where id = $1`,
      [f.farm_id],
    );
    const juniper = farm.parties.find((x) => x.displayName === 'Juniper Hill Farms LLC');
    expect(p.rows[0]?.p).toBe(juniper?.id);
    expect(
      await resolveExternalRef(t().pool, externalRef('deere', 'party', 'jh-client', HOME)),
    ).toBe(juniper?.id);
  });

  test('no home org: nothing is created, but fields that map are still updated', async () => {
    const r = await write(item({ sourceOrg: HOME, externalId: 'never-1', name: 'Never' }, null));
    expect(r).toMatchObject({ action: 'skipped', reason: 'no home org' });
    const n = await t().pool.query(
      `select count(*)::int as n from farm.fields where deere_field_id = 'never-1'`,
    );
    expect(n.rows[0]?.n).toBe(0);
    const f = homeFields[3] as (typeof farm.fields)[number];
    const u = await write(
      item({ sourceOrg: HOME, externalId: f.deereFieldId, name: 'Still renamed' }, null),
    );
    expect(u.parts).toEqual(['identity']);
    expect((await fieldRow(f.id)).name).toBe('Still renamed');
  });
});

describe('machines (Equipment API)', () => {
  const m = (
    org: string,
    principalId: string,
    kind: DeereMachineItem['machine']['kind'],
    typeName: string,
    archived = false,
  ): DeereMachineItem => ({
    machine: {
      source: 'deere',
      sourceOrg: org,
      externalId: principalId,
      name: `Unit ${principalId}`,
      kind,
      make: 'JOHN DEERE',
      model: '8R 410',
      year: 2024,
      vin: `SER${principalId}`,
    },
    typeName,
    archived,
    telematicsCapable: true,
  });
  const deereMachines = farm.machines.filter((x) => x.vendorIds.deere);
  const run = (home: string | null, items: DeereMachineItem[]) =>
    t().db.transaction(async (tx) => {
      const r = await upsertDeereMachines(tx, home, items);
      const changed = await writeUnmappedKinds(tx, r.unmappedKinds);
      return { ...r, changed };
    });

  beforeAll(async () => {
    await t().pool.query(
      `insert into ingest.sync_state (source, stream, mode, extra) values ('deere', 'equipment', 'sim', '{"callsPerRun": 7}')
       on conflict do nothing`,
    );
  });

  test('matched by principalId ref (never changed); a new mappable home machine is created; others listed', async () => {
    const before = await t().pool.query(`select count(*)::int as n from farm.machines`);
    const r = await run(HOME, [
      ...deereMachines.map((x) => m(HOME, x.vendorIds.deere as string, 'tractor', 'Tractor')),
      m(HOME, '900001', 'tractor', '4WD Tractor'),
      m(HOME, '900002', null, 'Utility Vehicle'),
      m(HOME, '900003', null, 'Utility Vehicle'),
      m(HOME, '900004', null, 'Loader'),
      m(HOME, '900005', 'combine', 'Combine', true),
      m('org-customer-1', '900006', 'combine', 'Combine'),
    ]);
    expect(r.matched).toBe(deereMachines.length);
    expect(r.created).toEqual([deterministicId('deere', '900001')]);
    expect(r.unmappedKinds).toEqual({ 'Utility Vehicle': 2, Loader: 1 });
    expect(r.skipped).toBe(2); // the archived one and the customer's
    expect(r.changed).toBe(true);
    const after = await t().pool.query(`select count(*)::int as n from farm.machines`);
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n as number) + 1);
    const created = await t().pool.query(
      `select kind, unit_no, make, model, year, vin_serial, source, source_id, kind_set_by
         from farm.machines where id = $1`,
      [deterministicId('deere', '900001')],
    );
    expect(created.rows[0]).toEqual({
      kind: 'tractor',
      unit_no: 'Unit 900001',
      make: 'JOHN DEERE',
      model: '8R 410',
      year: 2024,
      vin_serial: 'SER900001',
      source: 'deere',
      source_id: '900001',
      kind_set_by: 'vendor',
    });
    // The seeded machines keep their kind (a planter's tractor stays a planter).
    const planter = farm.machines.find((x) => x.kind === 'planter');
    const p = await t().pool.query(`select kind from farm.machines where id = $1`, [planter?.id]);
    expect(p.rows[0]?.kind).toBe('planter');
  });

  test('the unmappable list is merged into sync_state extra and only "changes" when it does', async () => {
    const same = await run(HOME, [
      m(HOME, '900002', null, 'Utility Vehicle'),
      m(HOME, '900003', null, 'Utility Vehicle'),
      m(HOME, '900004', null, 'Loader'),
    ]);
    expect(same.changed).toBe(false);
    const extra = await t().pool.query(
      `select extra from ingest.sync_state where source = 'deere' and stream = 'equipment'`,
    );
    expect(extra.rows[0]?.extra).toEqual({
      callsPerRun: 7,
      unmappedKinds: { Loader: 1, 'Utility Vehicle': 2 },
    });
    const gone = await run(HOME, []);
    expect(gone.changed).toBe(true);
    const cleared = await t().pool.query(
      `select extra from ingest.sync_state where source = 'deere' and stream = 'equipment'`,
    );
    expect(cleared.rows[0]?.extra).toEqual({ callsPerRun: 7, unmappedKinds: {} });
  });

  test('no home org: no machine is created; mapped ones still match', async () => {
    const r = await run(null, [
      m(HOME, '900010', 'tractor', 'Tractor'),
      m(HOME, '900001', 'tractor', 'Tractor'),
    ]);
    expect(r).toMatchObject({ created: [], matched: 1, skipped: 1 });
  });
});
