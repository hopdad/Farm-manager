/**
 * Contract tests of deere.ops's Deere calls (./client.ts, ./poll.ts) and mapping (./mapper.ts)
 * against the stand-in in-process with the real sim world (`createSimWorld`: day reports), an
 * injectable wall clock and an in-memory token store: this season's planting and the fields the
 * simulation finished, wall-time stamps, embedded measurements (no per-operation call), coverage
 * and the 400 refusal, the `ag2` scope (every call deere.ops makes is an organization or field
 * listing or an `ag2` path; a grant without `ag2` fails the step with what to do), skipped orgs,
 * unchanged operations, the per-run field cap and the deadline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { currentCropYear } from '../../../domain/crops';
import { createSimWorld } from '../../../sim/index';
import { CURRENT_CROP_YEAR, cropFor } from '../../../sim/seasons';
import { SIM_DEERE_HOME_ORG } from '../../../sim/types';
import type { DeereRouteModule } from '../../../sim/vendors/deere/modules';
import { deereOpsRoutes } from '../../../sim/vendors/deere/ops-routes';
import { SIM_OPS_REFUSED_EVERY, simOperationId } from '../../../sim/vendors/deere/ops-world';
import { apiError } from '../../../sim/vendors/deere/platform';
import { deereModuleWith } from '../../../sim/vendors/deere/routes';
import { json } from '../../../sim/vendors/http';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import type { DemoWorld } from '../../../sim/world';
import { type ConnectorConfig, type DeereEndpoints, deereEndpoints } from '../../endpoints';
import { MemoryTokenStore } from '../../oauth/memory-store';
import { collectingLogger } from '../../testkit';
import { DeereClient } from '../client';
import { exchangeDeereCode } from '../oauth';
import { mapDeereOperation } from './mapper';
import { DeereScopeError, type OpsPollDeps, pollDeereOperations } from './poll';

const WALL = Date.parse('2026-10-31T13:00:00.000Z');
let wall = WALL;
const now = () => new Date(wall);
const calls: string[] = [];
const http = {
  now,
  timeoutMs: 5000,
  sleep: async (ms: number) => {
    wall += ms;
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    calls.push(u.pathname.replace(/^\/deere/, ''));
    return fetch(input, init);
  }) as typeof fetch,
};

/** Refuses org-customer-1 (403) and marks org-customer-2 as needing approval (`connections`). */
const approvals: DeereRouteModule = {
  key: 'connections',
  route: (r) =>
    r.orgIds.includes('org-customer-1')
      ? apiError(403, 'Access Denied: the organization has not connected the application')
      : null,
  orgLinks: (org) =>
    org.id === 'org-customer-2'
      ? [{ rel: 'connections', uri: 'https://connections.deere.com/connections/sim' }]
      : [],
};

let sim: VendorSim;
let ep: DeereEndpoints;
let world: DemoWorld;

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createSimWorld,
    port: 0,
    now,
    modules: { deere: deereModuleWith([approvals, deereOpsRoutes]) },
  });
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3112' };
  ep = deereEndpoints('sim', cfg);
}, 60_000);
afterAll(() => sim?.close());
beforeEach(() => {
  wall = WALL;
  sim.control.reset({ scenario: 'harvest-day' });
  world = sim.world as DemoWorld;
  calls.length = 0;
});

function deps(over: Partial<OpsPollDeps> = {}): OpsPollDeps {
  const tokens = new MemoryTokenStore('deere', null, { now });
  return {
    client: new DeereClient({ endpoints: ep, tokens, http }),
    now,
    stopAt: new Date(WALL + 3_600_000),
    cropSeason: currentCropYear(now()),
    fieldCap: null,
    storedModified: async () => new Map(),
    log: collectingLogger(),
    ...over,
  };
}

const homeFields = () =>
  world.farm.fields.filter(
    (f) => world.farm.farms.find((u) => u.id === f.farmId)?.deereOrgId === SIM_DEERE_HOME_ORG,
  );

/** The first field the scenario's day 0 finishes, and when (sim). */
function firstFinished() {
  const work = world.dayReport(0).work.filter((w) => w.op === 'harvest');
  const w = [...work].sort((a, b) => a.lastAt.localeCompare(b.lastAt))[0];
  if (!w) throw new Error('no harvest work on day 0');
  return { work: w, field: world.farm.fields.find((f) => f.id === w.fieldId) };
}

describe('deere.ops against the stand-in (sim world)', () => {
  test("at the scenario's start every home field shows its spring planting", async () => {
    const r = await pollDeereOperations(null, deps());
    expect(r.stats.skippedOrgs.sort()).toEqual(['org-customer-1', 'org-customer-2']);
    expect(r.stats.fieldsChecked).toBe(homeFields().length);
    const ops = r.items.flatMap((i) => mapDeereOperation(i.payload));
    expect(ops.length).toBe(homeFields().length);
    for (const op of ops) {
      expect(op.kind).toBe('seeding');
      expect(op.cropYear).toBe(2026);
      expect(op.sourceOrg).toBe(SIM_DEERE_HOME_ORG);
      expect(Date.parse(op.endedAt as string)).toBeLessThanOrEqual(WALL);
      expect(op.products[0]).toMatchObject({ kind: 'seed', rateUnit: 'seeds1ac-1' });
      expect(op.machineExternalIds).toEqual(['6272546']); // planter P1's JDLink id
      expect(op.operatorName).toBe('Dale Mercer');
    }
    const field = homeFields()[0];
    const mine = ops.find((o) => o.fieldExternalId === field?.deereFieldId);
    expect(mine?.crop).toBe(field ? cropFor(1, field, CURRENT_CROP_YEAR) : null);
    expect(mine?.areaAc).toBeCloseTo(field?.acres ?? 0, 0);
    // Measurements came embedded: no per-operation measurementTypes call.
    expect(calls.filter((c) => c.endsWith('/measurementTypes'))).toEqual([]);
  }, 30_000);

  test('a field the simulation finishes shows its harvest, stamped in wall time', async () => {
    const { work, field } = firstFinished();
    expect(field).toBeDefined();
    const simDone = Date.parse(work.lastAt) + 60_000;
    sim.control.clock({ action: 'jump', simTime: new Date(simDone).toISOString() });
    wall += 20_000; // a job run 20 s later
    const r = await pollDeereOperations(null, deps());
    const ops = r.items.flatMap((i) => mapDeereOperation(i.payload));
    const harvest = ops.find(
      (o) => o.kind === 'harvest' && o.fieldExternalId === field?.deereFieldId,
    );
    expect(harvest).toBeDefined();
    // Sim instant lastAt is 60 s (at 1x) before the jump; the jump happened 20 s ago.
    expect(Date.parse(harvest?.endedAt as string)).toBe(WALL - 60_000);
    expect(harvest?.areaAc).toBeCloseTo(work.acres, 0);
    expect(harvest?.crop).toBe('corn');
    expect(harvest?.measurements.yieldBuAc).toBeGreaterThan(100);
    expect(harvest?.measurements.moisturePct).toBeGreaterThan(10);
    expect(harvest?.machineExternalIds.length).toBeGreaterThan(0);
    const refused = world.farm.fields.indexOf(field as never) % SIM_OPS_REFUSED_EVERY === 5;
    expect(harvest?.coverage === null).toBe(refused);
    // Its id is the stand-in's deterministic one.
    expect(harvest?.externalId).toBe(
      simOperationId(field?.key ?? '', 'harvest', String(currentCropYear(now()))),
    );
  }, 30_000);

  test("a field with an active boundary: Deere's 400 = no coverage, measured area kept", async () => {
    const field = world.farm.fields.find(
      (_, i) => i % SIM_OPS_REFUSED_EVERY === SIM_OPS_REFUSED_EVERY - 1,
    );
    const r = await pollDeereOperations(null, deps());
    const item = r.items.find((i) => i.payload.fieldId === field?.deereFieldId);
    expect(item?.payload.coverageStatus).toBe('refused');
    expect(item?.payload.coverage).toBeNull();
    const op = mapDeereOperation(item?.payload)[0];
    expect(op?.coverage).toBeNull();
    expect(op?.areaAc).toBeGreaterThan(10);
    // The cursor remembers the refusal: the field's next operation spends no boundary call.
    const cursor = JSON.parse(r.cursor) as { refused: Record<string, string> };
    expect(Object.keys(cursor.refused)).toContain(`${SIM_DEERE_HOME_ORG}|${field?.deereFieldId}`);
    // The others got the field boundary as coverage.
    const other = r.items.find((i) => i.payload.coverageStatus === 'ok');
    expect(mapDeereOperation(other?.payload)[0]?.coverage?.type).toBe('MultiPolygon');
  }, 30_000);

  test('every call is a listing or an ag2 path, and unchanged operations cost nothing', async () => {
    const first = await pollDeereOperations(null, deps());
    const ag2 =
      /^\/platform\/(organizations\/[^/]+\/fields\/[^/]+\/fieldOperations|fieldOperations\/[^/]+(\/measurementTypes|\/boundary)?)$/;
    const listings = /^\/platform\/organizations(\/[^/]+\/fields)?$/;
    const oauth = /^\/oauth2\//;
    for (const c of calls) expect(ag2.test(c) || listings.test(c) || oauth.test(c), c).toBe(true);

    const stored = new Map(
      first.items.map((i) => [
        i.externalId,
        new Date(i.payload.operation.modifiedTime as string).toISOString(),
      ]),
    );
    calls.length = 0;
    const again = await pollDeereOperations(first.cursor, {
      ...deps(),
      storedModified: async (ids) => new Map(ids.map((id) => [id, stored.get(id) ?? null])),
    });
    expect(again.items).toEqual([]);
    expect(again.stats.unchanged).toBe(first.items.length);
    expect(calls.filter((c) => c.endsWith('/boundary'))).toEqual([]);
  }, 30_000);

  test('a grant without ag2 fails the step with what to do', async () => {
    const tokens = new MemoryTokenStore('deere', null, { now });
    const url = new URL(`${ep.authBase}/v1/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: ep.clientId,
      redirect_uri: ep.redirectUri,
      scope: 'offline_access ag1 eq1',
      state: 's',
      sim_auto_consent: '1',
    }).toString();
    const res = await fetch(url, { redirect: 'manual' });
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    await tokens.save(await exchangeDeereCode(ep, code, http));
    const p = pollDeereOperations(null, {
      ...deps(),
      client: new DeereClient({ endpoints: ep, tokens, http, autoConnect: false }),
    });
    await expect(p).rejects.toBeInstanceOf(DeereScopeError);
    await expect(p).rejects.toThrow(/scope ag2/);
  }, 30_000);

  test('the per-run field cap checks the fields checked longest ago first', async () => {
    const total = homeFields().length;
    const a = await pollDeereOperations(null, deps({ fieldCap: 5 }));
    expect(a.stats.fieldsChecked).toBe(5);
    expect(a.stats.fields).toBe(total);
    const checkedA = Object.keys(JSON.parse(a.cursor).checked);
    wall += 60_000;
    const b = await pollDeereOperations(a.cursor, deps({ fieldCap: 5 }));
    const cur = JSON.parse(b.cursor).checked as Record<string, string>;
    const checkedB = Object.keys(cur).filter((k) => cur[k] === new Date(wall).toISOString());
    expect(checkedB).toHaveLength(5);
    for (const k of checkedB) expect(checkedA).not.toContain(k);
    expect(Object.keys(cur)).toHaveLength(10);
  }, 30_000);

  test('no field is started after stopAt: the cursor keeps the rest for the next run', async () => {
    const r = await pollDeereOperations(null, deps({ stopAt: now() }));
    expect(r.stats.fieldsChecked).toBe(0);
    expect(r.items).toEqual([]);
    expect(JSON.parse(r.cursor).checked).toEqual({});
  }, 30_000);

  test('the full-day sprayer knob emits one application with a full-size coverage', async () => {
    const field = homeFields()[1];
    const res = await fetch(`${sim.url}/_control/vendor/deere/ops/full-day`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fieldKey: field?.key }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fullDay: { fieldKey: field?.key } });
    const r = await pollDeereOperations(null, deps());
    const item = r.items.find(
      (i) =>
        i.payload.fieldId === field?.deereFieldId &&
        i.payload.operation.fieldOperationType === 'application',
    );
    expect(item?.payload.coverage?.multipolygons.length).toBeGreaterThan(40_000);
    const op = mapDeereOperation(item?.payload)[0];
    expect(op?.products.map((p) => p.name)).toEqual([
      'Tank Mix',
      'Water',
      'Glyphosate 5.5',
      '2,4-D LV6',
      'AMS',
    ]);
    expect(op?.operatorName).toBe('Luis Ortega');
  }, 60_000);

  test('the knobs answer JSON and refuse bad input', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${sim.url}/_control/vendor/deere/ops${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/full-day', { fieldKey: 'no-such-field' })).status).toBe(400);
    expect((await post('/refuse', { fieldKeys: 'x' })).status).toBe(400);
    const field = homeFields()[0];
    const ok = await post('/refuse', { fieldKeys: [field?.key] });
    expect(await ok.json()).toEqual({ fullDay: null, refuse: [field?.key] });
    const r = await pollDeereOperations(null, deps());
    const item = r.items.find((i) => i.payload.fieldId === field?.deereFieldId);
    expect(item?.payload.coverageStatus).toBe('refused');
    expect(json(200, {}).kind).toBe('reply');
  }, 30_000);
});
