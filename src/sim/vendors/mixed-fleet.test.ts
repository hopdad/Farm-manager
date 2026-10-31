/**
 * The 1f.2 mixed demo fleet in the stand-in (docs/contracts-1f.md part B): each vendor lists
 * exactly its own machines, the carmaker-cloud pickups report on their own sparser grid and leave
 * out the stats their route doesn't report (never 0), and every telematics machine has a vendor
 * whose stand-in will list it.
 *
 * Parts (docs/contracts-1f.md §1.3): the Samsara vehicle-feed tests are fleet-faults'; the
 * Motive test is trucks'; the world test at the end is the integrator's. Each part B builder
 * tests its own stand-in in its own directory (nothing here asserts what an unbuilt stand-in
 * answers).
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
    // Ford Pro and Stellantis through Samsara: fuel only (engine hours and odometer unconfirmed;
    // no official source lists Stellantis engine hours).
    expect(kinds('PU1')).toEqual(['fuelPercents']);
    expect(kinds('PU2')).toEqual(['fuelPercents']);
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
});

describe('the mixed fleet in the world', () => {
  test('every telematics vendor has machines its stand-in will list, each on one connection', () => {
    const farm = sim.world.farm;
    const units = (v: Parameters<typeof simTelematicsMachines>[1], o = {}) =>
      simTelematicsMachines(farm, v, o).map((m) => m.unitNo);
    expect(units('geotab')).toEqual(['H2']);
    expect(units('terminal')).toEqual(['H3']);
    expect(units('cnh')).toEqual(['C3', 'T1']);
    expect(units('aemp', { provider: 'kubota' })).toEqual(['L1']);
    // The AEMP provider `samsara` serves Samsara's asset-gateway machines (the same ids).
    expect(units('aemp', { provider: 'samsara' })).toEqual(['SP2']);
    expect(units('samsara', { feed: 'equipment' })).toEqual(['SP2']);
    expect(units('aemp', { provider: 'cnh' })).toEqual([]);
  });
});
