/**
 * fleet.vehicles end to end (sim and replay): Samsara's vehicle list against the stand-in (the
 * demo world) and the seeded farm, through applyVendorVehicle. The pickups get kind `pickup` from
 * their `Pickup` tag and their carmaker route (Ford Pro, Stellantis) from the record; the semis
 * stay semis with no via; ONE invalidate per run that changed something; a kind set on
 * /admin/vehicles survives every later tag; vehicles the farm doesn't map are never landed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { setMachineKindByAdmin } from '../../db/queries/vehicles';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { createFleetVehiclesJob } from '../../jobs/fleet-vehicles';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { simTelematicsMachines } from '../../sim/types';
import { SAMSARA_SIM_VEHICLE_TAGS_PATH } from '../../sim/vendors/samsara/vehicles-routes-control';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const onFeed = simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' });
const pu1 = onFeed.find((m) => m.unitNo === 'PU1');
const pu2 = onFeed.find((m) => m.unitNo === 'PU2');
let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const job = (over: Partial<FleetConfig> = {}) =>
  createFleetVehiclesJob({
    config: () => ({ ...cfg, ...over }),
    http: { timeoutMs: 2000, sleep: async () => {} },
  });
const ctx = () => testJobContext(t(), { name: 'fleet.vehicles' });

async function kinds() {
  const r = await t().pool.query(
    `select unit_no, kind, kind_set_by, telematics_via from farm.machines
      where id = any($1::uuid[]) order by unit_no`,
    [onFeed.map((m) => m.id)],
  );
  return Object.fromEntries(
    r.rows.map((x) => [x.unit_no, [x.kind, x.kind_set_by, x.telematics_via]]),
  );
}
const invalidates = () =>
  listener
    .of('fleet', 'invalidate')
    .filter((m) => (m.payload as { reason?: string }).reason === 'changed');

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0 });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3117',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_SAMSARA: 'sim',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_DEERE: 'off',
    FLEET_STALE_SECONDS: 60,
    FLEET_STALE_SECONDS_DEERE: 600,
  };
  await seedSimFarm(t().adminDb, farm);
  // As a database seeded before the pickups had a route: kinds and vias unknown.
  await t().pool.query(
    `update farm.machines set kind = 'semi', telematics_via = null where id = any($1::uuid[])`,
    [[pu1?.id, pu2?.id]],
  );
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.vehicles (sim)', () => {
  test('tags set the kinds and the records the carmaker routes; ONE invalidate', async () => {
    const before = invalidates().length;
    expect(await job()(ctx())).toEqual({ items: 6 });
    await listener.settle();
    expect(await kinds()).toEqual({
      PU1: ['pickup', 'vendor', 'ford_pro'],
      PU2: ['pickup', 'vendor', 'stellantis'],
      S1: ['semi', 'vendor', null],
      S2: ['semi', 'vendor', null],
      S3: ['semi', 'vendor', null],
      S4: ['semi', 'vendor', null],
    });
    expect(invalidates().length - before).toBe(1);
    const st = await t().pool.query(
      `select mode, last_ok_at is not null as ok from ingest.sync_state
        where source = 'samsara' and stream = 'vehicles'`,
    );
    expect(st.rows).toEqual([{ mode: 'sim', ok: true }]);
  });

  test('nothing changed: nothing landed, no invalidate', async () => {
    const before = invalidates().length;
    expect(await job()(ctx())).toEqual({ items: 0 });
    await listener.settle();
    expect(invalidates().length).toBe(before);
  });

  test('a kind set on /admin/vehicles survives a later tag; a plain re-tag moves a vendor kind', async () => {
    await setMachineKindByAdmin(t().pool, pu2?.id as string, 'service_truck');
    const tag = async (vehicleId: string, tags: string[] | null) => {
      const res = await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vehicleId, tags }),
      });
      expect(res.status).toBe(200);
    };
    await tag(pu2?.telematics?.id as string, ['Semi']);
    await tag(pu1?.telematics?.id as string, ['Service truck']);
    expect(await job()(ctx())).toEqual({ items: 2 });
    const k = await kinds();
    expect(k.PU2).toEqual(['service_truck', 'admin', 'stellantis']);
    expect(k.PU1).toEqual(['service_truck', 'vendor', 'ford_pro']);
    await tag(pu1?.telematics?.id as string, null);
    await tag(pu2?.telematics?.id as string, null);
  });

  test('tags back where they were (Pickup → Semi → Pickup) move the kind back', async () => {
    const tag = async (tags: string[] | null) => {
      const res = await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vehicleId: pu1?.telematics?.id, tags }),
      });
      expect(res.status).toBe(200);
    };
    await tag(['Semi']);
    await job()(ctx());
    expect((await kinds()).PU1?.[0]).toBe('semi');
    await tag(null);
    await job()(ctx());
    expect((await kinds()).PU1).toEqual(['pickup', 'vendor', 'ford_pro']);
  });

  test('a vehicle the farm does not map is never landed', async () => {
    await t().pool.query(
      `delete from ingest.external_refs where source = 'samsara' and entity_id = $1`,
      [pu1?.id],
    );
    const landed = async () =>
      (
        await t().pool.query(
          `select count(*)::int as n from ingest.raw_events
            where source = 'samsara' and stream = 'vehicles' and external_id like $1`,
          [`${pu1?.telematics?.id}:%`],
        )
      ).rows[0].n;
    const before = await landed();
    // A change Samsara reports for it: still not landed, since the farm doesn't map it.
    const res = await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicleId: pu1?.telematics?.id, tags: ['Service truck'] }),
    });
    expect(res.status).toBe(200);
    await job()(ctx());
    expect(await landed()).toBe(before);
    await seedSimFarm(t().adminDb, farm);
  });
});

describe('fleet.vehicles (replay)', () => {
  test('the doc-derived vehicle list lands: pickups and semis by their tags', async () => {
    await t().pool.query(
      `update farm.machines set kind = 'semi', kind_set_by = 'default', telematics_via = null
        where id = any($1::uuid[])`,
      [[pu1?.id, pu2?.id]],
    );
    const r = await job({ CONNECTOR_SAMSARA: 'replay' })(ctx());
    expect(r.items).toBeGreaterThan(0);
    const k = await kinds();
    expect(k.PU1).toEqual(['pickup', 'vendor', 'ford_pro']);
    expect(k.PU2).toEqual(['pickup', 'vendor', 'stellantis']);
  });
});
