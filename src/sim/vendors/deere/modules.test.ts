/**
 * The 1f seam of the Deere stand-in (docs/contracts-1f.md §7): the core router dispatches
 * platform calls to route modules (first non-null wins, before the core routes), modules add
 * links to each org of GET /organizations, knobs are served at /_control/vendor/deere/<key>/...,
 * and the context reaches the demo world's day reports (null for the stub world).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DeereClient } from '../../../connectors/deere/client';
import {
  DEERE_EQUIPMENT_MEDIA_TYPE,
  deereEquipmentListSchema,
  deereFieldsSchema,
  deereOrganizationsSchema,
} from '../../../connectors/deere/schemas';
import { type ConnectorConfig, deereEndpoints } from '../../../connectors/endpoints';
import { MemoryTokenStore } from '../../../connectors/oauth/memory-store';
import { buildDemoFarm } from '../../farm/build';
import { createSimWorld } from '../../index';
import { simExternalRefs } from '../../types';
import { simDayReportsOf } from '../context';
import { json } from '../http';
import { startVendorSim, type VendorSim } from '../server';
import { createStubSimWorld } from '../stub-world';
import { type DeereRouteModule, deereModuleState } from './modules';
import { pagedReply, simDeereFields } from './platform';
import { DEERE_ROUTE_MODULES, deereModuleWith } from './routes';

const seen: { days: boolean | null } = { days: null };

/**
 * A connections module whose knob blocks one org (the stub world has only org-home): every
 * request that names it, a /platform/organizations/{org}/… path or the Equipment API's
 * `organizationIds`.
 */
const connections: DeereRouteModule = {
  key: 'connections',
  route: ({ ctx, orgIds }) => {
    const blocked = deereModuleState(ctx, 'connections').blocked;
    return typeof blocked === 'string' && orgIds.includes(blocked)
      ? json(403, { errors: [{ message: 'needs approval' }] })
      : null;
  },
  orgLinks: (org, { ctx }) =>
    org.id === deereModuleState(ctx, 'connections').blocked
      ? [{ rel: 'connections', uri: 'https://connections.example/approve' }]
      : [],
  control: (req, ctx) => {
    if (req.path !== '/block') return null;
    const bag = deereModuleState(ctx, 'connections');
    bag.blocked = (JSON.parse(req.body || '{}') as { orgId?: string | null }).orgId ?? null;
    ctx.persist();
    return json(200, { path: req.path, blocked: bag.blocked });
  },
};

const block = (orgId: string | null, key = 'connections') =>
  fetch(`${sim.url}/_control/vendor/deere/${key}/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId }),
  });

const fields: DeereRouteModule = {
  key: 'fields',
  route: ({ req, ctx, parts }) => {
    if (parts.length === 3 && parts[0] === 'organizations' && parts[2] === 'fields') {
      seen.days = ctx.days !== null;
      return pagedReply(req, [
        { '@type': 'Field', id: `${parts[1]}-f1`, name: 'North 80' },
        { '@type': 'Field', id: `${parts[1]}-f2`, name: 'South 40' },
      ]);
    }
    return null;
  },
  orgLinks: (org, { base }) => [{ rel: 'fields', uri: `${base}/organizations/${org.id}/fields` }],
};

let sim: VendorSim;
let client: DeereClient;

function newClient(): DeereClient {
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3114' };
  return new DeereClient({
    endpoints: deereEndpoints('sim', cfg),
    tokens: new MemoryTokenStore('deere', null),
    http: { timeoutMs: 2_000, maxRetries: 0 },
  });
}

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createStubSimWorld,
    port: 0,
    modules: { deere: deereModuleWith([connections, fields]) },
  });
  client = newClient();
});
afterAll(() => sim.close());

describe('Deere stand-in route modules', () => {
  test('the shipped stand-in has the three 1f modules, in dispatch order', () => {
    expect(DEERE_ROUTE_MODULES.map((m) => m.key)).toEqual(['connections', 'fields', 'ops']);
  });

  test('a module serves its path (paged like the core); the stub world has no day reports', async () => {
    const list = await client.getPaged(
      deereFieldsSchema,
      `${client.apiUrl('organizations', 'org-home', 'fields')}?itemLimit=1`,
    );
    expect(list.map((f) => f.id)).toEqual(['org-home-f1', 'org-home-f2']);
    expect(seen.days).toBe(false);
  });

  test('modules add org links; an earlier module refuses an org before the later ones', async () => {
    const rels = async () =>
      (await client.getOne(deereOrganizationsSchema, client.apiUrl('organizations'))).values
        .find((o) => o.id === 'org-home')
        ?.links?.map((l) => l.rel);
    // A connected org: `self` and `manage_connections` (Deere's docs), plus the modules' links.
    expect(await rels()).toEqual(['self', 'manage_connections', 'fields']);
    // The knob (persisted in the module's bag) blocks the org.
    expect(await (await block('org-home')).json()).toEqual({ path: '/block', blocked: 'org-home' });
    expect(await rels()).toEqual(['self', 'connections', 'fields']);
    await expect(client.fields('org-home')).rejects.toMatchObject({ status: 403 });
    // The core's own org-scoped routes are refused too (modules run first), the Equipment API's
    // listing included (its org is in `organizationIds`).
    await expect(client.machines('org-home')).rejects.toMatchObject({ status: 403 });
    await block(null);
    expect(await client.machines('org-home')).toEqual(expect.any(Array));
    expect(await rels()).toEqual(['self', 'manage_connections', 'fields']);
  });

  test('a path no module or core route serves is 404 "not simulated"', async () => {
    await expect(
      client.getPaged(deereFieldsSchema, client.apiUrl('organizations', 'org-home', 'flags')),
    ).rejects.toMatchObject({ status: 404, detail: expect.stringMatching(/not simulated/) });
  });

  test('a knob path no module serves is 404; reset clears the knobs', async () => {
    expect((await block('org-home', 'fields')).status).toBe(404);
    expect((await block('org-home', 'nope')).status).toBe(404);
    await block('org-home');
    sim.control.reset(); // also drops the grants: sign in again
    expect(await newClient().machines('org-home')).toEqual(expect.any(Array));
  });
});

describe('core field listing and machine details (1f)', () => {
  let bare: VendorSim;
  let c: DeereClient;
  beforeAll(async () => {
    // No modules: what deere-ops sees in sim before deere-data's fields module lands.
    bare = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      modules: { deere: deereModuleWith([]) },
    });
    const cfg: ConnectorConfig = { VENDOR_SIM_URL: bare.url, PUBLIC_URL: 'http://localhost:3112' };
    c = new DeereClient({
      endpoints: deereEndpoints('sim', cfg),
      tokens: new MemoryTokenStore('deere', null),
      http: { timeoutMs: 2_000, maxRetries: 0 },
    });
  });
  afterAll(() => bare.close());

  test("simDeereFields lists exactly the seed's Deere field refs (owning org, then sharedWith)", () => {
    const farm = buildDemoFarm();
    const listed = simDeereFields(farm).map((f) => `${f.orgId}|${f.deereFieldId}|${f.field.id}`);
    const refs = simExternalRefs(farm)
      .filter((r) => r.ref.kind === 'field')
      .map((r) => `${r.ref.sourceOrg}|${r.ref.externalId}|${r.entityId}`);
    expect(listed.sort()).toEqual(refs.sort());
    expect(simDeereFields(farm).filter((f) => f.shared).length).toBeGreaterThan(0);
  });

  test('the core serves each org its fields, paged, and refuses unknown orgs', async () => {
    const list = await c.getPaged(
      deereFieldsSchema,
      `${c.apiUrl('organizations', 'org-home', 'fields')}?itemLimit=1`,
    );
    expect(list.map((f) => [f.id, f.name, f.archived])).toEqual([
      ['stub-fld-north', expect.any(String), false],
    ]);
    expect(list[0]?.links?.map((l) => l.rel)).toEqual([
      'self',
      'owningOrganization',
      'fieldOperation',
    ]);
    await expect(c.fields('org-nobody')).rejects.toMatchObject({ status: 403 });
  });

  test("the Equipment API lists each org's machines: principalId ≠ id, ISG type, make, model", async () => {
    const machines = await c.machines('org-home');
    expect(machines.length).toBeGreaterThan(0);
    for (const m of machines) {
      expect(m).toMatchObject({
        principalId: expect.any(String),
        isgType: { name: expect.any(String) },
        type: { name: expect.any(String) },
        make: { name: expect.any(String) },
        model: { name: expect.any(String) },
        modelYear: expect.stringMatching(/^\d{4}$/),
      });
      expect(m.id).not.toBe(m.principalId);
    }
    // Deere's rules: organizationIds is required, one org at a time, application/json.
    const url = `${c.endpoints.equipmentBase}/equipment`;
    await expect(c.getOne(deereEquipmentListSchema, url)).rejects.toMatchObject({
      status: 406,
    });
    await expect(
      c.getOne(deereEquipmentListSchema, url, { accept: DEERE_EQUIPMENT_MEDIA_TYPE }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      c.getOne(deereEquipmentListSchema, `${url}?organizationIds=org-home,org-nobody`, {
        accept: DEERE_EQUIPMENT_MEDIA_TYPE,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // The deprecated /platform machines API is gone.
    await expect(
      c.getPaged(deereFieldsSchema, c.apiUrl('organizations', 'org-home', 'machines')),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('a module answers the fields path before the core (shadowing)', async () => {
    // The shared `sim` above has the test fields module: its reply, not the core's.
    const list = await newClient().fields('org-home');
    expect(list.map((f) => f.id)).toEqual(['org-home-f1', 'org-home-f2']);
  });
});

describe('day reports in the stand-in context', () => {
  test("the demo world's reports are reachable; the stub world has none", () => {
    expect(simDayReportsOf(createStubSimWorld({ scenario: 'harvest-day' }))).toBeNull();
    const world = createSimWorld({ scenario: 'harvest-day' });
    const days = simDayReportsOf(world);
    expect(days).not.toBeNull();
    const day0 = days?.dayIndexAt(world.startsAt);
    expect(day0).toBe(0);
    const report = days?.dayReport(0);
    expect(report?.dayIndex).toBe(0);
    expect(report?.work.length).toBeGreaterThan(0);
    expect(days?.dayWindow(0).start.getTime()).toBeLessThanOrEqual(world.startsAt.getTime());
  });
});
