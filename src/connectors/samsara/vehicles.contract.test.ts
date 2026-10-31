/**
 * Contract tests: the Samsara vehicle-list client against the stand-in (in-process, the demo
 * world) and against the doc-derived replay fixture: the six vehicles on Samsara's vehicle feeds
 * with their tags, the pickups without a gateway, the snapshot diff (a re-tag shows up once), the
 * mapped-only filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSimWorld } from '../../sim/index';
import { simTelematicsMachines } from '../../sim/types';
import { SAMSARA_SIM_VEHICLE_TAGS_PATH } from '../../sim/vendors/samsara/vehicles-routes-control';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import type { ConnectorConfig } from '../endpoints';
import { SamsaraVehiclesClient } from './vehicles-client';
import { mapSamsaraVehicle } from './vehicles-mapper';

const NOW = Date.parse('2026-10-15T14:00:00.000Z');
let sim: VendorSim;
let cfg: ConnectorConfig;
const http = { now: () => new Date(NOW), timeoutMs: 2000, sleep: async () => {} };

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(NOW) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3117' };
});
afterAll(() => sim.close());
beforeEach(() => sim.control.reset({ scenario: 'harvest-day' }));

const byName = (vs: ReturnType<typeof mapSamsaraVehicle>) =>
  Object.fromEntries(vs.map((v) => [v.name, [v.kindFromTags, v.via]]));

describe('Samsara GET /fleet/vehicles (sim)', () => {
  test('the six vehicles with their tags: pickups through their carmaker cloud, semis on a gateway', async () => {
    const c = SamsaraVehiclesClient.forMode('sim', cfg, http);
    const list = await c.vehicles();
    const ids = new Set(
      simTelematicsMachines(sim.world.farm, 'samsara', { feed: 'vehicle' }).map(
        (m) => m.telematics?.id,
      ),
    );
    expect(new Set(list.map((v) => v.id))).toEqual(ids);
    expect(byName(list.flatMap((vehicle) => mapSamsaraVehicle({ vehicle })))).toEqual({
      S1: ['semi', null],
      S2: ['semi', null],
      S3: ['semi', null],
      S4: ['semi', null],
      PU1: ['pickup', 'ford_pro'],
      PU2: ['pickup', 'stellantis'],
    });
  });

  test('snapshot diff: everything once, then only a vehicle someone re-tagged', async () => {
    const c = SamsaraVehiclesClient.forMode('sim', cfg, http);
    const first = await c.pollVehicles(null);
    expect(first.items).toHaveLength(6);
    expect((await c.pollVehicles(first.cursor)).items).toEqual([]);
    const pu2 = simTelematicsMachines(sim.world.farm, 'samsara', { feed: 'vehicle' }).find(
      (m) => m.unitNo === 'PU2',
    )?.telematics?.id as string;
    const res = await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicleId: pu2, tags: ['Service truck'] }),
    });
    expect(res.status).toBe(200);
    const next = await c.pollVehicles(first.cursor);
    expect(next.items.map((i) => i.payload.vehicle.id)).toEqual([pu2]);
    expect(mapSamsaraVehicle(next.items[0]?.payload as never)[0]?.kindFromTags).toBe(
      'service_truck',
    );
  });

  test('only the mapped vehicles are landed', async () => {
    const pu1 = simTelematicsMachines(sim.world.farm, 'samsara', { feed: 'vehicle' }).find(
      (m) => m.unitNo === 'PU1',
    )?.telematics?.id as string;
    const c = SamsaraVehiclesClient.forMode('sim', cfg, http, { only: new Set([pu1]) });
    expect((await c.pollVehicles(null)).items.map((i) => i.payload.vehicle.id)).toEqual([pu1]);
  });
});

describe('Samsara GET /fleet/vehicles (replay)', () => {
  test('the doc-derived fixture lists the same six with the same kinds and vias', async () => {
    const c = SamsaraVehiclesClient.forMode('replay', cfg, http);
    const list = await c.vehicles();
    expect(byName(list.flatMap((vehicle) => mapSamsaraVehicle({ vehicle })))).toEqual({
      S1: ['semi', null],
      S2: ['semi', null],
      S3: ['semi', null],
      S4: ['semi', null],
      PU1: ['pickup', 'ford_pro'],
      PU2: ['pickup', 'stellantis'],
    });
  });
});
