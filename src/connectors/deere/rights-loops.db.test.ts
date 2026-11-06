/**
 * The data-rights gate in every Deere per-org loop, SANDBOX mode against the stand-in (D17,
 * docs/contracts-2a.md §4.4; done-when §11.4 "each Deere loop tested in sandbox mode against
 * the stand-in with a refused customer org: its data is not read, the others are"):
 *
 *   locations      fleet.deere   (DeereClient.pollLocationsWithOrgs)
 *   fields sync    deere.fields  (DeereFieldsRun.orgs)
 *   fields client  DeereFieldsApi.connectedOrgs (asFieldSource, as the contract tests use it)
 *   operations     deere.ops     (pollDeereOperations)
 *
 * The world: the demo farm in the stand-in (orgs org-home, org-customer-1 = Halvorsen,
 * org-customer-2 = Juniper Hill), both customer orgs LINKED to their parties, an agreement on
 * file for Juniper Hill only, DEERE_HOME_ORG_ID = org-home. Every request the client makes is
 * recorded (loopback only): no call ever names org-customer-1; calls name the home org and
 * org-customer-2. Then: the home org unknown (DEERE_HOME_ORG_ID unset, several member orgs)
 * fails closed (the farm's own org refused too, the agreed org still read), and sim reads every
 * org whatever is on file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { upsertExternalRef } from '../../db/external-refs';
import { listConnectorOrgs } from '../../db/queries/connector-orgs';
import { dataRightsAgreements } from '../../db/schema';
import { PERMITTED_USES } from '../../domain/work-jobs';
import { createDeereFieldsJob, type DeereFieldsConfig } from '../../jobs/deere-fields';
import { createDeereOpsJob, type DeereOpsConfig } from '../../jobs/deere-ops';
import { createFleetDeereJob, type FleetDeereConfig } from '../../jobs/fleet-deere';
import { createSimWorld } from '../../sim/index';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG, simCustomerOrgParties } from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import type { DemoWorld } from '../../sim/world';
import { setupTestDb } from '../../test/db';
import { deereEndpoints } from '../endpoints';
import { tokenKey } from '../oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../oauth/token-store';
import { seedSimFarm, testJobContext } from '../testkit';
import { externalRef } from '../types';
import { DeereClient } from './client';
import { DeereFieldsApi } from './fields/client';
import { simAutoConnect } from './oauth';
import { HOME_ORG_UNKNOWN_DETAIL, loadOrgReadRights, NO_AGREEMENT_DETAIL } from './rights';

const t = setupTestDb(import.meta.url);
const REFUSED = 'org-customer-1';
const AGREED = 'org-customer-2';
const KEY = 'ad'.repeat(32);
const now = () => new Date('2026-10-31T13:00:00.000Z');

let sim: VendorSim;
let world: DemoWorld;
const requested: string[] = [];

/** Loopback only (a sandbox client must never reach Deere), every request recorded. */
const loopbackOnly: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error(`test refused a call to ${url.host}`);
  requested.push(decodeURIComponent(`${url.pathname}${url.search}`));
  return fetch(input, init);
};
const http = { timeoutMs: 5_000, baseBackoffMs: 1, maxRetries: 0, fetch: loopbackOnly };

/** Requests that name `org` (an org-scoped platform path, or the Equipment API's filter). */
const naming = (org: string) =>
  requested.filter(
    (p) => p.includes(`/organizations/${org}/`) || p.includes(`organizationIds=${org}`),
  );

let base: FleetDeereConfig & DeereFieldsConfig & DeereOpsConfig;
const sandbox = (home: string | null = SIM_DEERE_HOME_ORG) => ({
  ...base,
  CONNECTOR_DEERE: 'sandbox' as const,
  DEERE_CLIENT_ID: SIM_CREDENTIALS.deere.clientId,
  DEERE_CLIENT_SECRET: SIM_CREDENTIALS.deere.clientSecret,
  DEERE_API_BASE: `${sim.url}/deere/platform`,
  DEERE_EQUIPMENT_API_BASE: `${sim.url}/deere/isg`,
  ...(home ? { DEERE_HOME_ORG_ID: home } : {}),
});

/** Let every stream run again at once (the runs below would otherwise be "not due"). */
const releaseStreams = () =>
  t().pool.query(`update ingest.sync_state set next_run_at = null where source = 'deere'`);

const halvorsenFields = () =>
  world.farm.fields.filter(
    (f) => world.farm.farms.find((u) => u.id === f.farmId)?.deereOrgId === REFUSED,
  );

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now });
  sim.control.reset({ scenario: 'harvest-day' });
  world = sim.world as DemoWorld;
  base = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3124',
    TOKEN_ENC_KEY: KEY,
    CONNECTOR_DEERE: 'sim',
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'off',
    FLEET_STALE_SECONDS: 600,
    FLEET_STALE_SECONDS_DEERE: 900,
  };
  await seedSimFarm(t().adminDb, world.farm);
  // Both customer orgs linked to their parties; only Juniper Hill (org-customer-2) has signed.
  for (const { orgId, partyId } of simCustomerOrgParties(world.farm)) {
    await upsertExternalRef(t().pool, externalRef('deere', 'party', orgId, orgId), partyId);
    if (orgId === AGREED) {
      await t()
        .db.insert(dataRightsAgreements)
        .values({ partyId, signedOn: '2026-01-01', permittedUses: [...PERMITTED_USES] });
    }
  }
  // A stored real-mode grant (org ''), minted by the stand-in: no refresh ever leaves loopback.
  const store = new OAuthTokenStore({
    pool: t().pool,
    source: 'deere',
    org: userGrantOrg(deereEndpoints('sandbox', sandbox())),
    key: tokenKey(KEY),
    now,
  });
  await simAutoConnect(deereEndpoints('sim', base), store, http);
}, 120_000);
afterAll(() => sim?.close());

beforeEach(async () => {
  requested.length = 0;
  await releaseStreams();
});

test("the run's rights: Juniper Hill's org is agreed, Halvorsen's (linked, unsigned) is not", async () => {
  const rights = await loadOrgReadRights(t().pool, 'sandbox', SIM_DEERE_HOME_ORG);
  expect([...rights.agreedOrgIds]).toEqual([AGREED]);
});

describe('sandbox, DEERE_HOME_ORG_ID set, Halvorsen without an agreement', () => {
  test('locations (fleet.deere): the refused org is stored blocked, never asked for', async () => {
    const ctx = testJobContext(t(), { name: 'fleet.deere', now });
    await createFleetDeereJob({ config: () => sandbox(), http })(ctx);
    expect(naming(REFUSED)).toEqual([]);
    expect(naming(SIM_DEERE_HOME_ORG).length).toBeGreaterThan(0);
    expect(naming(AGREED).length).toBeGreaterThan(0);
    const orgs = new Map(
      (await listConnectorOrgs(t().pool, 'deere', 'sandbox')).map((o) => [o.orgId, o]),
    );
    expect(orgs.get(REFUSED)).toMatchObject({
      status: 'needs_approval',
      detail: NO_AGREEMENT_DETAIL,
    });
    expect(orgs.get(AGREED)?.status).toBe('connected');
    expect(orgs.get(SIM_DEERE_HOME_ORG)?.status).toBe('connected');
  });

  test('fields sync (deere.fields): the refused org is skipped and logged; the others sync', async () => {
    const ctx = testJobContext(t(), { name: 'deere.fields', now });
    await createDeereFieldsJob({ config: () => sandbox(), http })(ctx);
    expect(naming(REFUSED)).toEqual([]);
    expect(
      naming(SIM_DEERE_HOME_ORG).some((p) => p.endsWith('/fields') || p.includes('/fields?')),
    ).toBe(true);
    expect(naming(AGREED).length).toBeGreaterThan(0);
    // Halvorsen's boundaries were never read: they stay the demo's.
    for (const f of halvorsenFields()) {
      const open = await t().pool.query(
        `select source from farm.field_boundaries where field_id = $1 and upper_inf(valid)`,
        [f.id],
      );
      expect(open.rows[0]?.source).toBe('demo');
    }
    const deere = await t().pool.query<{ n: number }>(
      `select count(*)::int as n from farm.field_boundaries where source = 'deere' and upper_inf(valid)`,
    );
    expect(deere.rows[0]?.n).toBeGreaterThan(0);
    const lines = ctx.log.lines.map((l) => `${l.msg} ${JSON.stringify(l.data ?? {})}`);
    expect(
      lines.some(
        (l) => l.includes('no data-rights agreement') && l.includes(REFUSED) && l.includes('D17'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes('no data-rights agreement') && l.includes(AGREED))).toBe(
      false,
    );
  });

  test('fields client (DeereFieldsApi): no field of the refused org is listed', async () => {
    const cfg = sandbox();
    const endpoints = deereEndpoints('sandbox', cfg);
    const client = new DeereClient({
      endpoints,
      tokens: new OAuthTokenStore({
        pool: t().pool,
        source: 'deere',
        org: userGrantOrg(endpoints),
        key: tokenKey(KEY),
        now,
      }),
      http,
    });
    const rights = await loadOrgReadRights(t().pool, 'sandbox', SIM_DEERE_HOME_ORG);
    const fields = await new DeereFieldsApi(client, { rights }).asFieldSource().listFields();
    expect(naming(REFUSED)).toEqual([]);
    expect(fields.length).toBeGreaterThan(0);
    const orgsListed = new Set(fields.map((f) => f.sourceOrg));
    expect(orgsListed.has(REFUSED)).toBe(false);
    expect(orgsListed.has(SIM_DEERE_HOME_ORG)).toBe(true);
    // Without rights (tools, contract tests) the same client lists the refused org too.
    requested.length = 0;
    const all = await new DeereFieldsApi(client).asFieldSource().listFields();
    expect(new Set(all.map((f) => f.sourceOrg)).has(REFUSED)).toBe(true);
    expect(naming(REFUSED).length).toBeGreaterThan(0);
  });

  test('operations (deere.ops): the refused org is skipped; its fields get no operations', async () => {
    const ctx = testJobContext(t(), { name: 'deere.ops', now });
    await createDeereOpsJob({ config: () => sandbox(), http })(ctx);
    expect(naming(REFUSED)).toEqual([]);
    expect(naming(SIM_DEERE_HOME_ORG).length).toBeGreaterThan(0);
    const ops = await t().pool.query<{ field_id: string }>(
      'select distinct field_id::text as field_id from farm.operations',
    );
    const withOps = new Set(ops.rows.map((r) => r.field_id));
    expect(withOps.size).toBeGreaterThan(0);
    for (const f of halvorsenFields()) expect(withOps.has(f.id)).toBe(false);
    expect(
      ctx.log.lines.some(
        (l) =>
          l.msg === 'deere.ops: org skipped' &&
          l.data?.orgId === REFUSED &&
          l.data?.why === NO_AGREEMENT_DETAIL,
      ),
    ).toBe(true);
  });
});

describe('sandbox with the home org unknown (several member orgs, no DEERE_HOME_ORG_ID)', () => {
  test("fails closed: the farm's own org is refused too; the agreed org is still read", async () => {
    const ctx = testJobContext(t(), { name: 'fleet.deere', now });
    await createFleetDeereJob({ config: () => sandbox(null), http })(ctx);
    expect(naming(REFUSED)).toEqual([]);
    expect(naming(SIM_DEERE_HOME_ORG)).toEqual([]);
    expect(naming(AGREED).length).toBeGreaterThan(0);
    const orgs = new Map(
      (await listConnectorOrgs(t().pool, 'deere', 'sandbox')).map((o) => [o.orgId, o]),
    );
    expect(orgs.get(SIM_DEERE_HOME_ORG)?.status).toBe('needs_approval');
    expect(orgs.get(REFUSED)?.status).toBe('needs_approval');
    expect(orgs.get(AGREED)?.status).toBe('connected');
    expect(HOME_ORG_UNKNOWN_DETAIL).toContain('set DEERE_HOME_ORG_ID');
  });
});

describe('sim: reported, never enforced', () => {
  test('every org is read whatever is on file', async () => {
    const ctx = testJobContext(t(), { name: 'fleet.deere', now });
    await createFleetDeereJob({ config: () => base, http })(ctx);
    expect(naming(REFUSED).length).toBeGreaterThan(0);
    expect(naming(AGREED).length).toBeGreaterThan(0);
    for (const o of await listConnectorOrgs(t().pool, 'deere', 'sim')) {
      expect(o.status).toBe('connected');
    }
  });
});
