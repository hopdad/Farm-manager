/**
 * The stand-in server in-process (random port, stub world): control API, persistence, loopback
 * guard and the generic faults. Vendor shapes are covered by the client contract tests in
 * src/connectors/**.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { samsaraErrorSchema } from '../../src/connectors/samsara/schemas';
import type { SimStatus } from '../../src/sim/types';
import { isLoopbackAddress, startVendorSim, type VendorSim } from '../../src/sim/vendors/server';
import { createStubSimWorld, STUB_STARTS_AT } from '../../src/sim/vendors/stub-world';
import { fileStateStore } from './state-file';

const TOKEN = { authorization: 'Bearer sim-samsara-token' };

async function post(sim: VendorSim, p: string, body: unknown) {
  const res = await fetch(`${sim.url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('vendor stand-in server', () => {
  let sim: VendorSim;
  beforeAll(async () => {
    sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0 });
  });
  afterAll(() => sim.close());

  test('status, clock pause/resume/speed/jump, scenario and reset', async () => {
    const status = (await (await fetch(`${sim.url}/_control/status`)).json()) as SimStatus;
    expect(status.scenario).toEqual({
      scenario: 'harvest-day',
      seed: 1,
      startsAt: STUB_STARTS_AT.toISOString(),
    });
    expect(status.faults).toEqual({ rules: [], scenarioRules: [] });

    const paused = await post(sim, '/_control/clock', { action: 'pause' });
    expect(paused.body.paused).toBe(true);
    const a = paused.body.simNow;
    await new Promise((r) => setTimeout(r, 30));
    const still = (await (await fetch(`${sim.url}/_control/clock`)).json()) as { simNow: string };
    expect(still.simNow).toBe(a);
    expect((await post(sim, '/_control/clock', { action: 'resume' })).body.paused).toBe(false);
    expect((await post(sim, '/_control/clock', { action: 'speed', speed: 30 })).body.speed).toBe(
      30,
    );
    const jumped = await post(sim, '/_control/clock', {
      action: 'jump',
      simTime: '2026-10-15T15:00:00Z',
    });
    expect(String(jumped.body.simNow) >= '2026-10-15T15:00:00').toBe(true);
    expect((await post(sim, '/_control/clock', { action: 'speed', speed: -1 })).status).toBe(400);
    expect((await post(sim, '/_control/clock', { action: 'warp' })).status).toBe(400);

    const sc = await post(sim, '/_control/scenario', { scenario: 'bad-morning' });
    expect(sc.body).toMatchObject({ scenario: 'bad-morning', seed: 1 });
    const after = (await (await fetch(`${sim.url}/_control/status`)).json()) as SimStatus;
    expect(after.faults.scenarioRules.map((r) => r.kind)).toContain('outage');
    expect(after.clock.speed).toBe(30); // a scenario switch keeps the speed

    const reset = await post(sim, '/_control/reset', { scenario: 'harvest-day' });
    expect(reset.status).toBe(200);
    expect((reset.body as unknown as SimStatus).clock.speed).toBe(1);
    expect((reset.body as unknown as SimStatus).faults.scenarioRules).toEqual([]);
  });

  test('faults: add, list, remove; outage drops, http_error and rate_limit are vendor-shaped', async () => {
    const feed = `${sim.url}/samsara/fleet/vehicles/locations/feed`;
    const added = await post(sim, '/_control/faults', {
      action: 'add',
      rule: { id: 'down', vendor: 'samsara', kind: 'outage', label: 'trucks API down' },
    });
    expect(added.body.rules).toEqual([
      { id: 'down', vendor: 'samsara', kind: 'outage', label: 'trucks API down' },
    ]);
    await expect(fetch(feed, { headers: TOKEN })).rejects.toThrow();
    // Other vendors are unaffected.
    expect((await fetch(`${sim.url}/deere/platform/organizations`)).status).toBe(401);
    await post(sim, '/_control/faults', { action: 'remove', id: 'down' });
    expect((await fetch(feed, { headers: TOKEN })).status).toBe(200);

    await post(sim, '/_control/faults', {
      action: 'set',
      rules: [{ id: 'boom', vendor: 'samsara', kind: 'http_error', status: 503 }],
    });
    const boom = await fetch(feed, { headers: TOKEN });
    expect(boom.status).toBe(503);
    expect(samsaraErrorSchema.safeParse(await boom.json()).success).toBe(true);

    await post(sim, '/_control/faults', {
      action: 'set',
      rules: [{ id: 'slow', vendor: 'samsara', kind: 'rate_limit', retryAfterSeconds: 7 }],
    });
    const limited = await fetch(feed, { headers: TOKEN });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');

    await post(sim, '/_control/faults', {
      action: 'set',
      rules: [{ id: 'lag', vendor: 'samsara', kind: 'latency', latencyMs: 150 }],
    });
    const t0 = Date.now();
    expect((await fetch(feed, { headers: TOKEN })).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    await post(sim, '/_control/faults', {
      action: 'set',
      rules: [{ id: 'hang', vendor: 'samsara', kind: 'timeout', latencyMs: 100 }],
    });
    await expect(fetch(feed, { headers: TOKEN })).rejects.toThrow();
    expect((await post(sim, '/_control/faults', { action: 'clear' })).body.rules).toEqual([]);
    expect(sim.counters.faults).toMatchObject({
      outage: 1,
      http_error: 1,
      rate_limit: 1,
      timeout: 1,
    });
  });

  test('unknown vendors and paths are 404; bad control bodies are 400', async () => {
    expect((await fetch(`${sim.url}/qbo/v3/company`)).status).toBe(404);
    expect((await fetch(`${sim.url}/nope`)).status).toBe(404);
    expect((await fetch(`${sim.url}/samsara/fleet/drivers`, { headers: TOKEN })).status).toBe(404);
    expect((await fetch(`${sim.url}/samsara/fleet/vehicles/locations/feed`)).status).toBe(401);
    const bad = await fetch(`${sim.url}/_control/faults`, { method: 'POST', body: '{' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${sim.url}/_control/reset`)).status).toBe(405);
  });

  test('only loopback callers may use the control API', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('state file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vendor-sim-'));
  const file = path.join(dir, 'vendor-sim', 'state.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('clock, faults and scenario survive a restart; a different scenario starts fresh', async () => {
    const first = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      store: fileStateStore(file),
    });
    first.control.clock({ action: 'speed', speed: 12 });
    first.control.faults({
      action: 'add',
      rule: { id: 'x', vendor: 'deere', kind: 'latency', latencyMs: 1 },
    });
    await first.close();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.faults).toHaveLength(1);

    const second = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      store: fileStateStore(file),
    });
    expect(second.status().clock.speed).toBe(12);
    expect(second.status().faults.rules.map((r) => r.id)).toEqual(['x']);
    await second.close();

    const third = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      store: fileStateStore(file),
      scenario: 'winter-idle',
    });
    expect(third.status().scenario.scenario).toBe('winter-idle');
    expect(third.status().faults.rules).toEqual([]);
    await third.close();
  });

  test('SIM_FROZEN_AT freezes at boot; a broken world fails with a clear error', async () => {
    const frozen = await startVendorSim({
      createWorld: createStubSimWorld,
      port: 0,
      frozenAt: new Date('2026-10-15T12:00:00Z'),
    });
    expect(frozen.status().clock).toMatchObject({
      paused: true,
      simNow: '2026-10-15T12:00:00.000Z',
    });
    await frozen.close();
    await expect(
      startVendorSim({
        createWorld: () => {
          throw new Error('not implemented yet');
        },
        port: 0,
      }),
    ).rejects.toThrow(/createSimWorld.*not implemented yet/);
  });
});
