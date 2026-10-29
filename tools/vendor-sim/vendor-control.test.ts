/**
 * The per-vendor control extension (M1): a module's `control` handler is served at
 * /_control/vendor/<vendor>/… behind the /_control guard, keeps its knobs in the persisted
 * per-vendor bag, and the NWS module is mounted at /nws.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { VendorModule } from '../../src/sim/vendors/context';
import { json } from '../../src/sim/vendors/http';
import { nwsModule } from '../../src/sim/vendors/nws/routes';
import { startVendorSim, type VendorSim } from '../../src/sim/vendors/server';
import { memoryStateStore } from '../../src/sim/vendors/state';
import { createStubSimWorld } from '../../src/sim/vendors/stub-world';

const windModule: VendorModule = {
  ...nwsModule,
  control(req, ctx) {
    ctx.state.vendors ??= {};
    ctx.state.vendors.nws ??= {};
    const nws = ctx.state.vendors.nws;
    if (req.method === 'POST' && req.path === '/wind') {
      nws.windMph = (JSON.parse(req.body) as { windMph: number }).windMph;
      ctx.persist();
    }
    return json(200, { path: req.path, windMph: nws.windMph ?? null });
  },
};

describe('stand-in vendor control', () => {
  let sim: VendorSim;
  const store = memoryStateStore();
  beforeAll(async () => {
    sim = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      store,
      modules: { nws: windModule },
    });
  });
  afterAll(() => sim.close());

  test('a module control handler answers under /_control/vendor/<vendor> and persists its knobs', async () => {
    const set = await fetch(`${sim.url}/_control/vendor/nws/wind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windMph: 18 }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ path: '/wind', windMph: 18 });
    const get = await fetch(`${sim.url}/_control/vendor/nws/wind`);
    expect(await get.json()).toEqual({ path: '/wind', windMph: 18 });
    expect(store.load()?.vendors?.nws).toEqual({ windMph: 18 });
  });

  test('the /_control guard applies (JSON only for POST)', async () => {
    const res = await fetch(`${sim.url}/_control/vendor/nws/wind`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(415);
  });

  test('vendors without a control API answer 404', async () => {
    expect((await fetch(`${sim.url}/_control/vendor/samsara/x`)).status).toBe(404);
    expect((await fetch(`${sim.url}/_control/vendor/nope/x`)).status).toBe(404);
  });
});

describe('NWS module', () => {
  let sim: VendorSim;
  beforeAll(async () => {
    sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0 });
  });
  afterAll(() => sim.close());

  test('is mounted at /nws and answers problem+json 404 outside its area (slice 1b)', async () => {
    const res = await fetch(`${sim.url}/nws/points/10.0,-84.0`, {
      headers: { 'user-agent': 'farm-test' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const root = (await (await fetch(`${sim.url}/`)).json()) as { vendors: string[] };
    expect(root.vendors).toContain('nws');
  });
});
