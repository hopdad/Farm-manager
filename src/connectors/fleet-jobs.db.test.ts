/**
 * The fleet.* jobs end to end in sim mode: the live clients against the stand-in (in-process,
 * stub world), a seeded farm (machines + external refs as the demo seed writes them), and the
 * real database: positions and machine_state upserted, exactly one batched fleet.tick per
 * claimed run (also when the poll fails, with machines going stale), no duplicate positions
 * under duplicate/out-of-order pages, Retry-After backoff, and Deere working breadcrumbs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fleetSnapshot } from '../db/queries/fleet';
import { type FleetTick, fleetTickSchema } from '../domain/fleet';
import { createFleetDeereJob, createFleetTrucksJob, type FleetConfig } from '../jobs/fleet';
import { SIM_DEERE_HOME_ORG } from '../sim/types';
import { startVendorSim, type VendorSim } from '../sim/vendors/server';
import { buildStubFarm, createStubSimWorld } from '../sim/vendors/stub-world';
import { setupTestDb } from '../test/db';
import { tokenKey } from './oauth/crypto';
import { OAuthTokenStore, SIM_GRANT_ORG } from './oauth/token-store';
import { listenAppEvents, seedSimFarm, testJobContext } from './testkit';
import { SyncStepError } from './types';

const t = setupTestDb(import.meta.url);
const farm = buildStubFarm();
const machineId = (unit: string) => farm.machines.find((m) => m.unitNo === unit)?.id as string;

/**
 * Wall clock shared by the stand-in and the jobs: frozen at the real start time so grid
 * instants are deterministic; tests move it on with `offset`.
 */
const base = Date.now();
let offset = 0;
const wall = () => new Date(base + offset);

let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const http = {
  timeoutMs: 2000,
  baseBackoffMs: 5,
  sleep: async (ms: number) => {
    offset += ms;
  },
};
const trucks = () => createFleetTrucksJob({ config: () => cfg, http });
const deere = () => createFleetDeereJob({ config: () => cfg, http });
const ctx = (name: string, at: () => Date = wall) => testJobContext(t(), { name, now: at });

async function ticksDuring(run: () => Promise<unknown>): Promise<FleetTick[]> {
  const before = listener.of('fleet', 'tick').length;
  await run().catch(() => {});
  await listener.settle();
  return listener
    .of('fleet', 'tick')
    .slice(before)
    .map((m) => {
      const { seq: _seq, ...tick } = m.payload;
      return fleetTickSchema.parse(tick);
    });
}

async function positionCounts() {
  const r = await t().pool.query<{ total: number; distinct: number }>(
    `select count(*)::int as total, count(distinct (machine_id, ts))::int as distinct
       from farm.positions`,
  );
  return r.rows[0] as { total: number; distinct: number };
}

async function machineState(unit: string) {
  const r = await t().pool.query(
    `select activity, position_source, current_field_id::text as field, fuel_pct, ts
       from farm.machine_state where machine_id = $1`,
    [machineId(unit)],
  );
  return r.rows[0];
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0, now: wall });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3103',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_SAMSARA: 'sim',
    CONNECTOR_MOTIVE: 'sim',
    CONNECTOR_DEERE: 'sim',
    FLEET_STALE_SECONDS: 600,
    FLEET_STALE_SECONDS_DEERE: 600,
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.trucks (Samsara, sim)', () => {
  test('a run upserts positions and machine_state and publishes ONE tick', async () => {
    let result: unknown;
    const ticks = await ticksDuring(async () => {
      result = await trucks()(ctx('fleet.trucks'));
    });
    expect(result).toEqual({ items: 3 + 9 }); // 3 positions + 9 stats (3 vehicles x 3 types)
    expect(ticks).toHaveLength(1);
    const tick = ticks[0] as FleetTick;
    expect(tick.machines.map((m) => m.unitNo).sort()).toEqual(['GC1', 'S1', 'S2']);
    expect(tick.machines.every((m) => !m.stale && m.positionSource === 'eld')).toBe(true);
    expect(await positionCounts()).toEqual({ total: 3, distinct: 3 });
    expect(await machineState('S1')).toMatchObject({
      activity: 'transport',
      position_source: 'eld',
    });
    expect(await machineState('S2')).toMatchObject({ activity: 'queued' }); // in the elevator yard
    expect((await machineState('S1')).fuel_pct).toBeGreaterThan(0); // from the stats feed
    const hours = await t().pool.query('select engine_hours from farm.machines where id = $1', [
      machineId('S1'),
    ]);
    expect(Number(hours.rows[0].engine_hours)).toBeGreaterThan(1000);
    expect(listener.of('admin', 'sync.status').length).toBeGreaterThanOrEqual(2);
  });

  test('the next run picks up where the cursor left off; no duplicate positions', async () => {
    offset += 30_000;
    const ticks = await ticksDuring(() => trucks()(ctx('fleet.trucks')));
    expect(ticks).toHaveLength(1);
    expect(await positionCounts()).toEqual({ total: 3 + 18, distinct: 21 }); // 6 instants x 3
  });

  test('duplicate and out-of-order pages create no duplicate positions or regressions', async () => {
    sim.control.faults({
      action: 'add',
      rule: { id: 'dup', vendor: 'samsara', kind: 'duplicate_page' },
    });
    offset += 20_000;
    await trucks()(ctx('fleet.trucks')); // the previous page again: lands nothing new
    expect(await positionCounts()).toEqual({ total: 21, distinct: 21 });
    expect(sim.counters.faults.duplicate_page).toBeGreaterThanOrEqual(1);
    sim.control.faults({
      action: 'set',
      rules: [{ id: 'ooo', vendor: 'samsara', kind: 'out_of_order' }],
    });
    offset += 20_000;
    await trucks()(ctx('fleet.trucks')); // shuffled: newest fix may land before older ones
    sim.control.faults({ action: 'clear' });
    offset += 20_000;
    await trucks()(ctx('fleet.trucks'));
    const c = await positionCounts();
    expect(c).toEqual({ total: 21 + 3 * 12, distinct: 21 + 3 * 12 }); // 60 s at 5 s, 3 vehicles
    const latest = await t().pool.query<{ newest: Date; state: Date }>(
      `select max(p.ts) as newest, s.ts as state from farm.positions p
         join farm.machine_state s on s.machine_id = p.machine_id
        where p.machine_id = $1 group by s.ts`,
      [machineId('S1')],
    );
    expect(latest.rows[0]?.state.getTime()).toBe(latest.rows[0]?.newest.getTime());
  });

  test('trucks API down: the run fails, still publishes a tick, and the trucks go stale', async () => {
    sim.control.faults({
      action: 'add',
      rule: { id: 'down', vendor: 'samsara', kind: 'outage', label: 'trucks API down' },
    });
    offset += 30_000;
    // Seen from 11 minutes later (FLEET_STALE_SECONDS = 600).
    const later = () => new Date(wall().getTime() + 11 * 60_000);
    let error: unknown;
    const ticks = await ticksDuring(async () => {
      try {
        await trucks()(ctx('fleet.trucks', later));
      } catch (e) {
        error = e;
        throw e;
      }
    });
    expect(error).toBeInstanceOf(SyncStepError);
    expect((error as SyncStepError).result).toMatchObject({ claimed: true, ok: false });
    expect((error as Error).message).toMatch(/samsara .*unreachable/);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.machines.filter((m) => m.unitNo.startsWith('S')).every((m) => m.stale)).toBe(
      true,
    );
    const st = await t().pool.query(
      `select last_error from ingest.sync_state where source = 'samsara' and stream = 'positions'`,
    );
    expect(st.rows[0].last_error).toMatch(/unreachable/);
    sim.control.faults({ action: 'remove', id: 'down' });

    // Back up: they catch up and are fresh again.
    offset += 30_000;
    const back = await ticksDuring(() => trucks()(ctx('fleet.trucks')));
    expect(back[0]?.machines.every((m) => !m.stale)).toBe(true);
  });

  test('429 with Retry-After: the stream backs off and the next firing is skipped', async () => {
    sim.control.faults({
      action: 'add',
      rule: {
        id: 'slow',
        vendor: 'samsara',
        kind: 'rate_limit',
        retryAfterSeconds: 30,
        pathPrefix: '/fleet/vehicles/locations/feed',
      },
    });
    offset = Date.now() - base; // job clock = database clock for next_run_at
    await expect(trucks()(ctx('fleet.trucks'))).rejects.toThrow(/HTTP 429/);
    const st = await t().pool.query(
      `select extract(epoch from (next_run_at - now()))::int as next_in from ingest.sync_state
        where source = 'samsara' and stream = 'positions'`,
    );
    expect(st.rows[0].next_in).toBeGreaterThan(20);
    expect(st.rows[0].next_in).toBeLessThanOrEqual(30);
    const ticks = await ticksDuring(async () => {
      expect(await trucks()(ctx('fleet.trucks'))).toEqual({
        items: expect.any(Number),
        note: 'lease held elsewhere',
      });
    });
    expect(ticks).toHaveLength(0); // not claimed: no tick
    sim.control.faults({ action: 'clear' });
    await t().pool.query(
      `update ingest.sync_state set next_run_at = null where source = 'samsara' and stream = 'positions'`,
    );
  });

  test("mode 'off' polls nothing", async () => {
    const off = createFleetTrucksJob({
      config: () => ({ ...cfg, CONNECTOR_SAMSARA: 'off' }),
      http,
    });
    expect(await off(ctx('fleet.trucks'))).toEqual({ items: 0, note: 'off' });
    await t().pool.query(`select app.ensure_stream('samsara', 'positions', 'sim')`);
    await t().pool.query(`select app.ensure_stream('samsara', 'stats', 'sim')`);
  });
});

describe('fleet.deere (sim)', () => {
  test('connects unattended, lands working breadcrumbs, marks the combine working in its field', async () => {
    sim.control.reset({});
    offset += 10 * 60_000; // ten sim minutes in: C1 working, GC1 transporting
    const ticks = await ticksDuring(() => deere()(ctx('fleet.deere')));
    expect(ticks).toHaveLength(1);
    const c1 = ticks[0]?.machines.find((m) => m.unitNo === 'C1');
    expect(c1).toMatchObject({
      activity: 'working',
      positionSource: 'deere_working',
      fieldId: farm.fields[0]?.id,
      stale: false,
    });
    const deerePositions = await t().pool.query(
      `select count(*)::int as n, count(distinct machine_id)::int as machines
         from farm.positions where source = 'deere'`,
    );
    expect(deerePositions.rows[0]).toEqual({ n: 60, machines: 1 });
    const tok = await t().pool.query(
      `select count(*)::int as n from ingest.oauth_tokens where source = 'deere'`,
    );
    expect(tok.rows[0].n).toBe(1);
    expect(sim.counters.tokenGrants.authorization_code).toBeGreaterThanOrEqual(1);
    // Org scoping: the refs it resolved are the home org's.
    expect(farm.machines.find((m) => m.unitNo === 'C1')?.deereOrgId).toBe(SIM_DEERE_HOME_ORG);
  });

  test('GET /api/fleet snapshot = the same machines, stale recomputed per request', async () => {
    const now = await fleetSnapshot(t().pool, wall(), 600);
    expect(fleetTickSchema.safeParse(now).success).toBe(true);
    expect(now.machines.map((m) => m.unitNo).sort()).toEqual(['C1', 'GC1', 'S1', 'S2']);
    const muchLater = await fleetSnapshot(t().pool, new Date(wall().getTime() + 3600_000), 600);
    expect(muchLater.machines.every((m) => m.stale)).toBe(true);
    // A retired machine drops off the board.
    await t().admin.query(`update farm.machines set status = 'retired' where unit_no = 'S2'`);
    const after = await fleetSnapshot(t().pool, wall(), 600);
    expect(after.machines.map((m) => m.unitNo)).not.toContain('S2');
  });
});

describe('fleet.deere keeps sim and real grants apart', () => {
  test("a sim run never reads, sends or replaces the real account's grant", async () => {
    const key = tokenKey(cfg.TOKEN_ENC_KEY);
    const real = new OAuthTokenStore({ pool: t().pool, source: 'deere', key });
    await real.save({
      accessToken: 'REAL-ACCESS',
      refreshToken: 'REAL-REFRESH',
      tokenType: 'Bearer',
      expiresAt: new Date(wall().getTime() + 3600_000),
      refreshExpiresAt: null,
      scopes: ['ag1', 'offline_access'],
    });
    // No sim grant yet: the sim client must connect its own instead of borrowing the real one.
    await t().pool.query(
      `delete from ingest.oauth_tokens where source = 'deere' and org_external_id = $1`,
      [SIM_GRANT_ORG],
    );
    const sent: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      sent.push(`${headers.get('authorization') ?? ''} ${String(init?.body ?? '')}`);
      return fetch(input, init);
    };
    offset += 2 * 60_000; // new breadcrumbs to land
    const job = createFleetDeereJob({ config: () => cfg, http: { ...http, fetch: recording } });
    const result = await job(ctx('fleet.deere'));
    expect(result.items).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((s) => s.includes('REAL-'))).toEqual([]);
    expect(await real.read()).toMatchObject({
      accessToken: 'REAL-ACCESS',
      refreshToken: 'REAL-REFRESH',
    });
    const rows = await t().pool.query<{ org: string }>(
      `select org_external_id as org from ingest.oauth_tokens where source = 'deere' order by 1`,
    );
    expect(rows.rows.map((r) => r.org)).toEqual(['', SIM_GRANT_ORG]);
  });
});
