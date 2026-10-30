/**
 * The 1f.2 mixed demo fleet in the stand-in (docs/contracts-1f.md part B): each vendor lists
 * exactly its own machines, the carmaker-cloud pickups report on their own sparser grid and leave
 * out the stats their route doesn't report (never 0), and the new vendors' modules exist but
 * serve nothing yet ("not simulated").
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SamsaraLocationsFeed, SamsaraStatsFeed } from '../../connectors/samsara/schemas';
import { createSimWorld } from '../index';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../types';
import { encodeFeedCursor } from './feed';
import { startVendorSim, type VendorSim } from './server';

const NOW = Date.parse('2026-11-30T15:00:00.000Z');
let sim: VendorSim;

const samsara = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${sim.url}/samsara${path}`, {
    headers: { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}` },
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
};

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(NOW) });
});
afterAll(() => sim.close());

describe('the mixed fleet in the stand-in', () => {
  test('Samsara vehicle feeds: the four semis and the two pickups, nobody else', async () => {
    const body = await samsara<SamsaraLocationsFeed>('/fleet/vehicles/locations/feed');
    const expected = simTelematicsMachines(sim.world.farm, 'samsara', { feed: 'vehicle' });
    expect(body.data.map((v) => v.name).sort()).toEqual(
      ['PU1', 'PU2', 'S1', 'S2', 'S3', 'S4'].sort(),
    );
    expect(new Set(body.data.map((v) => v.id))).toEqual(
      new Set(expected.map((m) => m.telematics?.id)),
    );
  });

  test('carmaker-cloud pickups report every 30 s, the trucks every 5 s', async () => {
    const after = encodeFeedCursor(NOW - 60_000);
    const body = await samsara<SamsaraLocationsFeed>(
      `/fleet/vehicles/locations/feed?after=${after}`,
    );
    const times = (name: string) =>
      body.data.find((v) => v.name === name)?.locations.map((l) => Date.parse(l.time)) ?? [];
    expect(times('S1')).toHaveLength(12);
    for (const pu of ['PU1', 'PU2']) {
      expect(times(pu)).toHaveLength(2);
      for (const t of times(pu)) expect(t % 30_000).toBe(0);
    }
  });

  test('stats the route does not report are left out, never sent as 0', async () => {
    const body = await samsara<SamsaraStatsFeed>(
      '/fleet/vehicles/stats/feed?types=obdEngineSeconds,fuelPercents,obdOdometerMeters',
    );
    const kinds = (name: string) =>
      Object.keys(body.data.find((v) => v.name === name) ?? {})
        .filter((k) => k !== 'id' && k !== 'name')
        .sort();
    expect(kinds('S1')).toEqual(['fuelPercents', 'obdEngineSeconds', 'obdOdometerMeters']);
    // Ford Pro: fuel (engine hours and odometer unconfirmed); Stellantis: engine hours and fuel.
    expect(kinds('PU1')).toEqual(['fuelPercents']);
    expect(kinds('PU2')).toEqual(['fuelPercents', 'obdEngineSeconds']);
  });

  test("Motive lists only its own vehicle (the hired hauler H1), in Motive's ids", async () => {
    const res = await fetch(`${sim.url}/motive/v1/vehicle_locations`, {
      headers: { 'x-api-key': SIM_CREDENTIALS.motive.apiKey },
    });
    const body = (await res.json()) as { vehicles: { vehicle: { id: string; number: string } }[] };
    expect(body.vehicles.map((v) => v.vehicle.number)).toEqual(['H1']);
    expect(body.vehicles[0]?.vehicle.id).toBe(
      simTelematicsMachines(sim.world.farm, 'motive')[0]?.telematics?.id,
    );
  });

  test('the new vendors and the Samsara route modules exist but serve nothing yet', async () => {
    for (const path of [
      '/geotab/apiv1',
      '/aemp/cnh/Fleet/1',
      '/aemp/kubota/Fleet/1',
      '/cnh/api/vehicles',
      '/terminal/tsp/v1/vehicles',
    ]) {
      const res = await fetch(`${sim.url}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toMatch(/not simulated/);
    }
    const equipment = await fetch(`${sim.url}/samsara/fleet/equipment/locations/feed`, {
      headers: { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}` },
    });
    expect(equipment.status).toBe(404);
    // Every telematics machine has a vendor whose stand-in will list it.
    for (const v of ['geotab', 'aemp'] as const) {
      expect(simTelematicsMachines(sim.world.farm, v).length, v).toBeGreaterThan(0);
    }
  });
});
