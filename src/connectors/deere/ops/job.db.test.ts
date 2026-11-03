/**
 * deere.ops end to end against the stand-in in-process (the real sim world: day reports) and a
 * database seeded with the demo farm (fields, boundaries, machines and exactly the external refs
 * the demo seed writes): this season's planting (and, D23, the wheat seeded this October under
 * next year's season) lands on the seeded fields with no duplicate,
 * a second run changes nothing and publishes nothing, a field the simulation finishes lands as
 * a harvest with `fields`/`updated` { parts: ['operations'] }, the provisional → final sweep,
 * `fieldsPerRun` in sync_state.extra, and the per-run field cap under a budget (a sandbox-mode
 * run pointed at the stand-in with seeded api_calls_daily and sync_state rows: the fields checked
 * longest ago go first, sim rows never count).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { deterministicId } from '../../../domain/ids';
import { createDeereOpsJob, type DeereOpsConfig } from '../../../jobs/deere-ops';
import { createSimWorld } from '../../../sim/index';
import { CURRENT_CROP_YEAR, cropFor } from '../../../sim/seasons';
import { SIM_CREDENTIALS } from '../../../sim/types';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import { SIM_OPS_REFUSED_EVERY } from '../../../sim/vendors/deere/ops-world';
import { simDeereFields } from '../../../sim/vendors/deere/platform';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import type { DemoWorld } from '../../../sim/world';
import { setupTestDb } from '../../../test/db';
import { deereEndpoints } from '../../endpoints';
import { tokenKey } from '../../oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../../oauth/token-store';
import { listenAppEvents, seedSimFarm, testJobContext } from '../../testkit';
import { exchangeDeereCode } from '../oauth';

const t = setupTestDb(import.meta.url);
const WALL = Date.parse('2026-10-31T13:00:00.000Z');
let wall = WALL;
const now = () => new Date(wall);
const http = {
  timeoutMs: 5000,
  sleep: async (ms: number) => {
    wall += ms;
  },
};

let sim: VendorSim;
let world: DemoWorld;
let cfg: DeereOpsConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const run = (c: DeereOpsConfig = cfg) =>
  createDeereOpsJob({ config: () => c, http })(testJobContext(t(), { name: 'deere.ops', now }));

/** Every demo field: its owning org (home or a customer's) lists its operations. */
const allFields = () => world.farm.fields;
/**
 * The fields seeded to wheat this October: the stand-in files that seeding under 2027 (D23
 * rule 3), the newer season of the window, so they have a second planting row.
 */
const wheatFields = () =>
  world.farm.fields.filter((f) => cropFor(world.seed, f, CURRENT_CROP_YEAR) === 'wheat');

async function operations() {
  const r = await t().pool.query(
    `select id::text, kind, field_id::text as field_id, status, geom is not null as has_geom,
            area_clipped_ac::float8 as clipped, area_reported_ac::float8 as reported,
            machine_ids::text[] as machines, operator_name, updated_at
       from farm.operations order by field_id, started_at`,
  );
  return r.rows;
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now });
  sim.control.reset({ scenario: 'harvest-day' });
  world = sim.world as DemoWorld;
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3112',
    TOKEN_ENC_KEY: 'ab'.repeat(32),
    CONNECTOR_DEERE: 'sim',
  };
  await seedSimFarm(t().adminDb, world.farm);
  listener = await listenAppEvents(t().appUrl);
}, 120_000);
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('deere.ops (sim)', () => {
  test("the first run lands every field's planting on the seeded fields", async () => {
    const before = listener.messages.length;
    // 2026's plantings, and 2027's wheat seeded this October (Oct 31: [2026, 2027]).
    expect(wheatFields().length).toBeGreaterThan(0);
    expect(await run()).toEqual({ items: allFields().length + wheatFields().length });
    const rows = await operations();
    expect(rows).toHaveLength(allFields().length + wheatFields().length);
    expect(new Set(rows.map((r) => r.field_id))).toEqual(new Set(allFields().map((f) => f.id)));
    const nextYear = await t().pool.query<{ field_id: string }>(
      `select field_id::text from farm.operations where crop_year = 2027 order by 1`,
    );
    expect(nextYear.rows.map((r) => r.field_id)).toEqual(
      wheatFields()
        .map((f) => f.id)
        .sort(),
    );
    const planter = world.farm.machines.find((m) => m.kind === 'planter');
    for (const r of rows) {
      expect(r).toMatchObject({ kind: 'seeding', status: 'final', operator_name: 'Dale Mercer' });
      expect(r.machines).toEqual([planter?.id]);
    }
    // Every SIM_OPS_REFUSED_EVERY-th field answered 400: stored with its area, no coverage.
    expect(rows.filter((r) => r.has_geom === false).length).toBeGreaterThan(0);
    for (const f of allFields()) {
      const r = rows.find((x) => x.field_id === f.id);
      // (A wheat field's two plantings, 2026's and 2027's, share the field's coverage rule.)
      const refused =
        world.farm.fields.indexOf(f) % SIM_OPS_REFUSED_EVERY === SIM_OPS_REFUSED_EVERY - 1;
      expect(r?.has_geom).toBe(!refused);
      if (refused) expect(r?.clipped).toBeNull();
      else expect(r?.clipped).toBeCloseTo(f.acres, -1);
      expect(r?.reported).toBeCloseTo(f.acres, 0);
    }
    await listener.settle();
    const fresh = listener.messages.slice(before);
    // More than 25 fields changed: one invalidate instead of a message per field.
    expect(fresh.filter((m) => m.topic === 'fields' && m.event === 'invalidate')).toHaveLength(1);
    expect(fresh.filter((m) => m.topic === 'admin' && m.event === 'sync.status')).toHaveLength(1);
    const extra = await t().pool.query(
      `select extra, mode from ingest.sync_state where source = 'deere' and stream = 'operations'`,
    );
    expect(extra.rows[0]).toMatchObject({
      mode: 'sim',
      // Every field every org lists (a sharing org's copies too, and deere-data's Deere-only
      // field: they list no operations).
      extra: {
        fieldsPerRun: simDeereFields(world.farm).length + (simDeereOnlyField(world.farm) ? 1 : 0),
      },
    });
  }, 120_000);

  test('a second run changes nothing and publishes no field message', async () => {
    const before = await operations();
    const sent = listener.messages.length;
    wall += 20_000;
    expect(await run()).toEqual({ items: 0 });
    expect(await operations()).toEqual(before);
    await listener.settle();
    expect(listener.messages.slice(sent).filter((m) => m.topic === 'fields')).toEqual([]);
  }, 60_000);

  test('a field the simulation finishes lands as a harvest and its panel is told', async () => {
    const work = world.dayReport(0).work.filter((w) => w.op === 'harvest');
    const first = [...work].sort((a, b) => a.lastAt.localeCompare(b.lastAt))[0];
    if (!first) throw new Error('no harvest on day 0');
    sim.control.clock({
      action: 'jump',
      simTime: new Date(Date.parse(first.lastAt) + 120_000).toISOString(),
    });
    wall += 20_000;
    const sent = listener.messages.length;
    expect(await run()).toEqual({ items: 1 });
    const harvest = (await operations()).find(
      (r) => r.kind === 'harvest' && r.field_id === first.fieldId,
    );
    expect(harvest).toMatchObject({ status: 'provisional' });
    expect(harvest?.machines).toEqual([first.machineId]);
    expect(harvest?.reported).toBeCloseTo(first.acres, 0);
    await listener.settle();
    const updated = listener
      .of('fields', 'updated')
      .filter((m) => listener.messages.indexOf(m) >= sent);
    expect(updated.map(({ payload: { seq: _seq, ...p } }) => p)).toEqual([
      { fieldId: first.fieldId, parts: ['operations'] },
    ]);
  }, 60_000);

  test('the harvest turns final 24 h after Deere last changed it, and the panel is told', async () => {
    // Pause the sim so no more work ends; a day of wall time passes.
    sim.control.clock({ action: 'pause' });
    wall += 24 * 3_600_000 + 60_000;
    const sent = listener.messages.length;
    await run();
    const rows = await operations();
    expect(rows.every((r) => r.status === 'final')).toBe(true);
    await listener.settle();
    const updated = listener
      .of('fields', 'updated')
      .filter((m) => listener.messages.indexOf(m) >= sent);
    expect(updated.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('deere.ops under a call budget (sandbox mode against the stand-in)', () => {
  test('the per-run cap holds run after run (D23: two seasons) and the fields checked longest ago go first', async () => {
    const sandbox: DeereOpsConfig = {
      ...cfg,
      CONNECTOR_DEERE: 'sandbox',
      DEERE_API_BASE: `${sim.url}/deere/platform`,
      DEERE_CLIENT_ID: SIM_CREDENTIALS.deere.clientId,
      DEERE_CLIENT_SECRET: SIM_CREDENTIALS.deere.clientSecret,
      DEERE_DAILY_CALL_BUDGET: 3000,
    };
    // A sandbox grant, minted by the stand-in (whose platform the sandbox base points at).
    const simEp = deereEndpoints('sim', cfg);
    const auth = new URL(`${simEp.authBase}/v1/authorize`);
    auth.search = new URLSearchParams({
      response_type: 'code',
      client_id: simEp.clientId,
      redirect_uri: simEp.redirectUri,
      scope: 'offline_access ag1 ag2 eq1',
      state: 's',
      sim_auto_consent: '1',
    }).toString();
    const res = await fetch(auth, { redirect: 'manual' });
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await exchangeDeereCode(simEp, code, { now });
    await new OAuthTokenStore({
      pool: t().pool,
      source: 'deere',
      org: userGrantOrg(deereEndpoints('sandbox', sandbox)),
      key: tokenKey(sandbox.TOKEN_ENC_KEY),
      now,
    }).save({ ...tokens, expiresAt: new Date(wall + 3_600_000 * 48) });

    // Yesterday (UTC) in sandbox: nothing else spent; sim rows never count. Measured:
    // locations 1 call a run (720 a day at its cron); operations on ten runs from before D23
    // (one listing a field, no runs kept with their fields): 44 calls a run (the org and field
    // listings, 4 calls, and a listing for each of 40 fields), the last run checked 40 fields.
    // This run lists two seasons a field (D23), so a field costs twice that:
    // share = max(300, 2400 − 0 − 720) = 1680 a day; cap = floor(1680 / (96 × 44/40 × 2)) = 7
    // (one season: floor(1680 / (96 × 44/40)) = 15).
    const share = 1680;
    const day = new Date(wall - 86_400_000).toISOString().slice(0, 10);
    await t().admin.query(
      `insert into ingest.api_calls_daily (source, stream, mode, day, calls)
       values ('deere', 'fields', 'sim', $1, 50000)`,
      [day],
    );
    await t().admin.query(
      `insert into ingest.sync_state (source, stream, mode, extra)
       values ('deere', 'locations', 'sandbox', '{"callsPerRun": 1, "callsPerRunMode": "sandbox"}')
       on conflict (source, stream) do update set extra = excluded.extra`,
    );
    await t().admin.query(
      `update ingest.sync_state
          set extra = (extra - 'runsRecent') || jsonb_build_object('callsPerRun', 44,
                'callsPerRunMode', 'sandbox', 'callsRecent', $1::jsonb, 'fieldsPerRun', 40),
              cursor = null, next_run_at = null
        where source = 'deere' and stream = 'operations'`,
      [JSON.stringify(Array(10).fill(44))],
    );
    wall += 60_000;
    await run(sandbox);
    const cursor = async () => {
      const r = await t().pool.query(
        `select cursor, extra from ingest.sync_state where source = 'deere' and stream = 'operations'`,
      );
      return {
        checked: JSON.parse(r.rows[0].cursor as string).checked as Record<string, string>,
        extra: r.rows[0].extra as Record<string, unknown>,
      };
    };
    const a = await cursor();
    expect(Object.keys(a.checked)).toHaveLength(7);
    expect(a.extra.fieldsPerRun).toBe(7);
    // sync-health kept the run with its calls, fields and seasons (D23).
    type Kept = { calls: number; fields: number; seasons: number };
    const kept = a.extra.runsRecent as Kept[];
    expect(kept).toEqual([
      { calls: (a.extra.callsRecent as number[]).at(-1), fields: 7, seasons: 2 },
    ]);

    // The next runs: calls per field from those same runs (Σ calls ÷ Σ fields), so the cap is
    // what the share holds at that cost and it stays there run after run. (A mean of calls
    // that still holds the pre-D23 runs, over this run's 7 fields, scaled ×2 again, would
    // halve it every run, down to 1.) Each run takes fields never checked.
    const capFrom = (runs: readonly Kept[]) =>
      Math.max(
        1,
        Math.floor(
          share /
            (96 * (runs.reduce((n, r) => n + r.calls, 0) / runs.reduce((n, r) => n + r.fields, 0))),
        ),
      );
    let seen = new Set(Object.keys(a.checked));
    let runs = kept;
    const caps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cap = capFrom(runs);
      caps.push(cap);
      wall += 60_000;
      await run(sandbox);
      const b = await cursor();
      const newest = Object.entries(b.checked)
        .filter(([, at]) => at === new Date(wall).toISOString())
        .map(([k]) => k);
      expect(newest).toHaveLength(cap);
      expect(b.extra.fieldsPerRun).toBe(cap);
      for (const k of newest) expect(seen.has(k)).toBe(false);
      seen = new Set([...seen, ...newest]);
      runs = b.extra.runsRecent as Kept[];
      expect(runs).toHaveLength(i + 2);
    }
    // Steady at about half the one-season cap (15), not collapsing: 4 calls of org and field
    // listings and 2 a field, 18 calls for 7 fields → floor(17.5 / (18/7)) = 6, then 16 for 6
    // run after run (the listings weigh more in a smaller run).
    expect(caps).toEqual([6, 6, 6]);
    // Its operations were written like sim's (same deterministic ids, nothing duplicated).
    const total = await t().pool.query('select count(*)::int as n from farm.operations');
    expect(total.rows[0].n).toBe(allFields().length + wheatFields().length + 1);
    expect(deterministicId('deere', 'x')).toMatch(/-/);
  }, 120_000);
});
