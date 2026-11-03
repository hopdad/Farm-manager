/**
 * deere.ops in January (D23, the growing year) end to end: the stand-in in-process (the real sim
 * world, harvest-day) and a database seeded with the demo farm, at a pinned wall clock of
 * 2027-01-15T15:00Z. One clock everywhere: the job's ctx.now, its HTTP client's now (httpFor),
 * the stand-in's now and the History route's now all read `wall`.
 *
 * The sync window is [2026, 2027]; the stand-in files its season under 2026 (the season being
 * harvested before Aug 1), so the run lands last season's plantings and the harvest the
 * simulation finished, nothing under 2027, and a field's History tab defaults to 2026. Under
 * the calendar-year rule (before D23) this run asked for 2027 only and the tab showed 2027.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleFieldOperations } from '../../../app/api/fields/[id]/operations/handler';
import { cropSeasonsToSync } from '../../../domain/crops';
import type { FieldOperationsResponse } from '../../../domain/operations';
import { createDeereOpsJob, type DeereOpsConfig } from '../../../jobs/deere-ops';
import { makeSession, runWithSession } from '../../../platform/auth/testing';
import { createSimWorld } from '../../../sim/index';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import type { DemoWorld } from '../../../sim/world';
import { setupTestDb } from '../../../test/db';
import { seedSimFarm, testJobContext } from '../../testkit';

const t = setupTestDb(import.meta.url);
const JANUARY = Date.parse('2027-01-15T15:00:00.000Z');
let wall = JANUARY;
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

function run() {
  const ctx = testJobContext(t(), { name: 'deere.ops', now });
  return { ctx, done: createDeereOpsJob({ config: () => cfg, http })(ctx) };
}

async function operations() {
  const r = await t().pool.query<{ kind: string; field_id: string; crop_year: number }>(
    `select kind, field_id::text as field_id, crop_year from farm.operations
      order by field_id, started_at`,
  );
  return r.rows;
}

/** The History tab's default answer for a field, at the same wall clock. */
async function historyDefault(fieldId: string): Promise<FieldOperationsResponse> {
  const res = await runWithSession(makeSession({ role: 'viewer' }), () =>
    handleFieldOperations(
      new Request(`http://localhost:3112/api/fields/${fieldId}/operations`),
      fieldId,
      t().pool,
      now(),
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as FieldOperationsResponse;
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now });
  sim.control.reset({ scenario: 'harvest-day' });
  world = sim.world as DemoWorld;
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3112',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_DEERE: 'sim',
  };
  await seedSimFarm(t().adminDb, world.farm);
}, 120_000);
afterAll(async () => {
  await sim?.close();
});

describe('deere.ops in January (2027-01-15, America/Detroit)', () => {
  test("lands last season's plantings, nothing under 2027; the History tab shows 2026", async () => {
    expect(cropSeasonsToSync(now())).toEqual([2026, 2027]);
    const { ctx, done } = run();
    expect(await done).toEqual({ items: world.farm.fields.length });
    const polled = ctx.log.lines.find((l) => l.msg === 'deere.ops: polled');
    expect(polled?.data).toMatchObject({ cropSeasons: [2026, 2027], seasonsPerField: 2 });

    const rows = await operations();
    expect(rows).toHaveLength(world.farm.fields.length);
    expect(rows.every((r) => r.kind === 'seeding' && r.crop_year === 2026)).toBe(true);

    const field = world.farm.fields[0];
    if (!field) throw new Error('no demo field');
    const body = await historyDefault(field.id);
    expect(body.cropYear).toBe(2026);
    expect(body.operations.map((o) => o.kind)).toEqual(['seeding']);
  }, 120_000);

  test('a harvest the simulation finishes in January is filed under 2026 and shows there', async () => {
    const work = world.dayReport(0).work.filter((w) => w.op === 'harvest');
    const first = [...work].sort((a, b) => a.lastAt.localeCompare(b.lastAt))[0];
    if (!first) throw new Error('no harvest on day 0');
    sim.control.clock({
      action: 'jump',
      simTime: new Date(Date.parse(first.lastAt) + 120_000).toISOString(),
    });
    wall += 20_000;
    expect(await run().done).toEqual({ items: 1 });
    const harvest = (await operations()).find(
      (r) => r.kind === 'harvest' && r.field_id === first.fieldId,
    );
    expect(harvest?.crop_year).toBe(2026);
    const body = await historyDefault(first.fieldId);
    expect(body.cropYear).toBe(2026);
    expect(body.operations.map((o) => o.kind)).toEqual(['seeding', 'harvest']);
    // Stamped in January's wall time (2 sim minutes at 1x before the jump): the late harvest of
    // last season.
    const h = body.operations.find((o) => o.kind === 'harvest');
    expect(Date.parse(h?.endedAt as string)).toBe(JANUARY - 120_000);
  }, 60_000);
});
