/**
 * fleet.deere with 1f's sync health (docs/contracts-1f.md §5.4, §5.5, §11.4), end to end against
 * the in-process stand-in on the demo world (several Deere orgs) and a real database:
 *
 *  - the app's call counts for a run equal the stand-in's own `/_control/stats`, under the run's
 *    mode, and a run's calls become the stream's `callsPerRun`;
 *  - the connections knob makes an org need approval: the run stays OK, that org is skipped (its
 *    equipment never asked for), the others keep flowing, ingest.connector_orgs holds each org's
 *    status for the mode, and the home org is kept in sync_state.extra;
 *  - sandbox mode against the stand-in (DEERE_API_BASE / DEERE_EQUIPMENT_API_BASE, a stored real
 *    grant; nothing may leave loopback) with DEERE_DAILY_CALL_BUDGET: next_run_at follows the
 *    split from the seeded last full UTC day (sandbox rows only: sim rows are ignored); the
 *    switch from sim keeps sim's org rows apart; with several member orgs and no
 *    DEERE_HOME_ORG_ID the home org is unknown, with the candidates to pick from.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listConnectorOrgs, storedHomeOrgOf } from '../db/queries/connector-orgs';
import { createFleetDeereJob, type FleetDeereConfig } from '../jobs/fleet-deere';
import { buildDemoFarm } from '../sim/farm/build';
import { createSimWorld } from '../sim/index';
import { SIM_DEERE_HOME_ORG } from '../sim/types';
import { DEERE_SIM_CONNECTIONS_CONTROL_PATH } from '../sim/vendors/deere/connections-control-types';
import { startVendorSim, type VendorSim } from '../sim/vendors/server';
import { setupTestDb } from '../test/db';
import { configuredCallMode, installCallCounting } from './call-budget';
import { lastFullUtcDay } from './deere/call-shares';
import { simAutoConnect } from './deere/oauth';
import { deereEndpoints } from './endpoints';
import { withCallStream } from './http';
import { tokenKey } from './oauth/crypto';
import { MemoryTokenStore } from './oauth/memory-store';
import { OAuthTokenStore } from './oauth/token-store';
import { listenAppEvents, seedSimFarm, testJobContext } from './testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();

let sim: VendorSim;
let base: FleetDeereConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;
let orgIds: string[] = [];
const requested: string[] = [];

/** Loopback only: a sandbox-mode client must never reach a real Deere host. */
const loopbackOnly: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error(`test refused a call to ${url.host}`);
  requested.push(`${url.pathname}${url.search}`);
  return fetch(input, init);
};
const http = { timeoutMs: 5_000, baseBackoffMs: 5, maxRetries: 0, fetch: loopbackOnly };
const job = (cfg: FleetDeereConfig) => createFleetDeereJob({ config: () => cfg, http });
const ctx = () => testJobContext(t(), { name: 'fleet.deere' });

const knob = (orgId: string, state: string) =>
  fetch(`${sim.url}${DEERE_SIM_CONNECTIONS_CONTROL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId, state }),
  }).then((r) => r.json());

async function callsToday(mode: string): Promise<number> {
  const r = await t().pool.query<{ n: number }>(
    `select coalesce(sum(calls), 0)::int as n from ingest.api_calls_daily
      where source = 'deere' and stream = 'locations' and mode = $1 and day = $2::date`,
    [mode, new Date().toISOString().slice(0, 10)],
  );
  return r.rows[0]?.n ?? 0;
}

async function locationsState() {
  const r = await t().pool.query(
    `select extra, extract(epoch from (next_run_at - now()))::int as next_in, last_error
       from ingest.sync_state where source = 'deere' and stream = 'locations'`,
  );
  return r.rows[0] as {
    extra: Record<string, unknown>;
    next_in: number | null;
    last_error: string | null;
  };
}

const releaseStream = () =>
  t().pool.query(
    `update ingest.sync_state set next_run_at = null where source = 'deere' and stream = 'locations'`,
  );

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0 });
  base = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3114',
    TOKEN_ENC_KEY: 'cd'.repeat(32),
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_DEERE: 'sim',
    FLEET_STALE_SECONDS: 600,
    FLEET_STALE_SECONDS_DEERE: 900,
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
  const status = (await (
    await fetch(`${sim.url}${DEERE_SIM_CONNECTIONS_CONTROL_PATH}`)
  ).json()) as {
    orgs: { id: string }[];
  };
  orgIds = status.orgs.map((o) => o.id);
}, 120_000);
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.deere sync health (sim)', () => {
  test("a run's calls in ingest.api_calls_daily match the stand-in's own count, under sim", async () => {
    const before = sim.counters.requests.deere ?? 0;
    const counted = await callsToday('sim');
    const result = await job(base)(ctx());
    expect(result).toEqual({ items: expect.any(Number) });
    const standIn = (sim.counters.requests.deere ?? 0) - before;
    expect(standIn).toBeGreaterThan(orgIds.length); // oauth + listing + equipment per org + crumbs
    expect((await callsToday('sim')) - counted).toBe(standIn);
    expect(await callsToday('sandbox')).toBe(0);
    const st = await locationsState();
    expect(st.extra).toMatchObject({ callsPerRun: standIn, callsPerRunMode: 'sim' });
    // Every org connected; the sim home org kept for /admin/connectors.
    const orgs = await listConnectorOrgs(t().pool, 'deere', 'sim');
    expect(orgs.map((o) => o.orgId).sort()).toEqual([...orgIds].sort());
    expect(orgs.every((o) => o.status === 'connected')).toBe(true);
    expect(storedHomeOrgOf(st.extra)).toMatchObject({ orgId: SIM_DEERE_HOME_ORG, source: 'sim' });
  });

  test('an org that needs approval is skipped; the run stays OK and the others keep flowing', async () => {
    const blocked = orgIds.find((id) => id !== SIM_DEERE_HOME_ORG) as string;
    await knob(blocked, 'needs_approval');
    await releaseStream();
    requested.length = 0;
    const c = ctx();
    const result = await job(base)(c);
    expect(result.items).toBeGreaterThanOrEqual(0);
    expect((await locationsState()).last_error).toBeNull();
    // The blocked org's equipment was never asked for; every other org's was.
    const equipment = requested.filter((p) => p.includes('/isg/equipment'));
    expect(equipment.some((p) => p.includes(`organizationIds=${blocked}`))).toBe(false);
    for (const id of orgIds.filter((x) => x !== blocked)) {
      expect(equipment.some((p) => p.includes(`organizationIds=${encodeURIComponent(id)}`))).toBe(
        true,
      );
    }
    const orgs = await listConnectorOrgs(t().pool, 'deere', 'sim');
    const row = orgs.find((o) => o.orgId === blocked);
    expect(row).toMatchObject({ status: 'needs_approval' });
    expect(row?.approvalUrl).toMatch(
      /connections\.deere\.com\/connections\/.+\/select-organizations/,
    );
    expect(orgs.filter((o) => o.orgId !== blocked).every((o) => o.status === 'connected')).toBe(
      true,
    );
    expect(
      c.log.lines.some((l) => l.msg.includes('needs approval') && l.data?.orgId === blocked),
    ).toBe(true);
    // Approved again: connected on the next run.
    await knob(blocked, 'connected');
    await releaseStream();
    await job(base)(ctx());
    expect(
      (await listConnectorOrgs(t().pool, 'deere', 'sim')).find((o) => o.orgId === blocked)?.status,
    ).toBe('connected');
  });
});

describe('fleet.deere in sandbox mode against the stand-in (budget pacing)', () => {
  let sandbox: FleetDeereConfig;

  beforeAll(async () => {
    sandbox = {
      ...base,
      CONNECTOR_DEERE: 'sandbox',
      DEERE_CLIENT_ID: 'sim-deere-client',
      DEERE_CLIENT_SECRET: 'sim-deere-secret',
      DEERE_API_BASE: `${sim.url}/deere/platform`,
      DEERE_EQUIPMENT_API_BASE: `${sim.url}/deere/isg`,
    };
    // A "real" (org '') grant the stand-in accepts, valid for the whole test: no refresh ever
    // goes to Deere's real token endpoint.
    const memory = new MemoryTokenStore('deere');
    await simAutoConnect(deereEndpoints('sim', base), memory, { fetch: loopbackOnly });
    const granted = memory.tokens;
    if (!granted) throw new Error('no sim grant');
    await new OAuthTokenStore({
      pool: t().pool,
      source: 'deere',
      org: '',
      key: tokenKey(base.TOKEN_ENC_KEY),
    }).save({ ...granted, expiresAt: new Date(Date.now() + 3600_000) });
    await releaseStream();
  });

  test('no budget: no pace; several member orgs and no DEERE_HOME_ORG_ID: home org unknown', async () => {
    await job(sandbox)(ctx());
    const st = await locationsState();
    expect(st.next_in).toBeNull();
    expect(st.extra).toMatchObject({ callsPerRunMode: 'sandbox' });
    const home = storedHomeOrgOf(st.extra);
    expect(home).toMatchObject({ orgId: null, source: 'unknown', mode: 'sandbox' });
    expect(home?.candidates.map((c) => c.id).sort()).toEqual([...orgIds].sort());
    // Sandbox rows of their own; sim's rows stay under sim (the page reads the current mode).
    expect((await listConnectorOrgs(t().pool, 'deere', 'sandbox')).length).toBe(orgIds.length);
    expect((await listConnectorOrgs(t().pool, 'deere', 'sim')).length).toBe(orgIds.length);
    await releaseStream();
    await job({ ...sandbox, DEERE_HOME_ORG_ID: SIM_DEERE_HOME_ORG })(ctx());
    expect(storedHomeOrgOf((await locationsState()).extra)).toMatchObject({
      orgId: SIM_DEERE_HOME_ORG,
      source: 'config',
    });
  });

  test('with a budget, next_run_at follows the split of the last full day (sim rows ignored)', async () => {
    const day = lastFullUtcDay(new Date());
    await t().pool.query(
      `insert into ingest.api_calls_daily (source, stream, mode, day, calls)
       values ('deere', 'locations', 'sandbox', $1::date, 3000),
              ('deere', 'fields', 'sandbox', $1::date, 1000),
              ('deere', 'flags', 'sandbox', $1::date, 500),
              ('deere', 'operations', 'sandbox', $1::date, 2000),
              ('deere', 'hours', 'sandbox', $1::date, 300),
              ('deere', 'operations', 'sim', $1::date, 900000)
       on conflict (source, stream, mode, day) do update set calls = excluded.calls`,
      [day],
    );
    // Calls per run as measured in sandbox (set, so the arithmetic is exact).
    await t().pool.query(
      `update ingest.sync_state
          set extra = extra || '{"callsPerRun": 12, "callsPerRunMode": "sandbox", "callsRecent": [12]}'::jsonb,
              next_run_at = null
        where source = 'deere' and stream = 'locations'`,
    );
    const c = ctx();
    await job({ ...sandbox, DEERE_DAILY_CALL_BUDGET: 10_000 })(c);
    // share = max(1 000, 8 000 − (1 000 + 500 + 2 000 + 300)) = 4 200 a day; 12 a run →
    // ceil(12 × 86 400 / 4 200) = 247 s (with the sim row counted it would be the floor: 1 037 s).
    const st = await locationsState();
    expect(st.next_in).toBeGreaterThan(237);
    expect(st.next_in).toBeLessThanOrEqual(247);
    expect(c.log.lines.some((l) => l.msg.includes('paced'))).toBe(true);
    // Not due again before then: the next firing claims nothing.
    expect(await job({ ...sandbox, DEERE_DAILY_CALL_BUDGET: 10_000 })(ctx())).toEqual({
      items: 0,
      note: 'lease held elsewhere',
    });
  });
});

describe('withCallStream outside a step (the CLIs)', () => {
  test("installCallCounting flushes a scope's calls under its label and the configured mode", async () => {
    const stop = installCallCounting(t().pool, (v) =>
      configuredCallMode({ CONNECTOR_DEERE: 'sim', CONNECTOR_SAMSARA: 'replay' }, v),
    );
    try {
      await withCallStream('record', async () => {
        const memory = new MemoryTokenStore('deere');
        await simAutoConnect(deereEndpoints('sim', base), memory, { fetch: loopbackOnly });
      });
    } finally {
      stop();
    }
    const r = await t().pool.query(
      `select source, stream, mode, calls from ingest.api_calls_daily where stream = 'record'`,
    );
    // The unattended consent: one authorize + one token call.
    expect(r.rows).toEqual([{ source: 'deere', stream: 'record', mode: 'sim', calls: 2 }]);
  });
});
