/**
 * The Motive stand-in on its own (the demo world, a frozen wall clock): Motive's documented
 * shapes for every path, the unit header, top-level paging on /v1/fault_codes, its 401 body,
 * and the control knobs' validation. The client's view of it is ./motive.contract.test.ts's
 * (src/connectors/motive).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  motiveCompaniesSchema,
  motiveFaultCodesSchema,
  motiveGroupsSchema,
  motiveVehicleLocationsSchema,
  motiveVehiclesSchema,
} from '../../../connectors/motive/schemas';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  MOTIVE_SIM_FAULT_CODES_PATH,
  MOTIVE_SIM_GATEWAY_PATH,
  type MotiveSimStatus,
  SIM_MOTIVE_COMPANY_ID,
} from './control-types';

let wall = Date.parse('2026-10-15T14:00:02.500Z');
let sim: VendorSim;

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${sim.url}/motive${path}`, {
    headers: { 'x-api-key': SIM_CREDENTIALS.motive.apiKey, 'x-metric-units': 'false', ...headers },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const knob = async (path: string, body: unknown) => {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as MotiveSimStatus & { error?: string } };
};

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = Date.parse('2026-10-15T14:00:02.500Z');
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('Motive stand-in', () => {
  test("a wrong key: Motive's own 401 body", async () => {
    const r = await get('/v2/vehicle_locations', { 'x-api-key': 'nope' });
    expect(r).toEqual({ status: 401, body: { error_message: 'invalid API key' } });
    expect((await get('/v1/nope')).status).toBe(404);
  });

  test('companies, v1/v2 (mph, stats) and v3 (gateway only: kph, engine state, no stats)', async () => {
    const companies = motiveCompaniesSchema.parse((await get('/v1/companies')).body);
    expect(companies.companies[0]?.company.id).toBe(SIM_MOTIVE_COMPANY_ID);
    const [h1] = simTelematicsMachines(sim.world.farm, 'motive');
    const sample = sim.world.machineAt(h1?.id as string, new Date(sim.status().clock.simNow));
    for (const api of ['v1', 'v2'] as const) {
      const body = motiveVehicleLocationsSchema.parse(
        (await get(`/${api}/vehicle_locations`)).body,
      );
      expect(body.vehicles.map((v) => v.vehicle.number)).toEqual(['H1']);
      const l = body.vehicles[0]?.vehicle.current_location;
      expect(l?.located_at).toBe('2026-10-15T14:00:00.000Z'); // the 5 s grid, no jitter
      expect(l?.kph).toBeUndefined();
      expect(l?.true_engine_hours).toBeCloseTo(sample?.engineHours ?? 0, 0);
      expect(l?.true_engine_hours).toBeGreaterThan(l?.engine_hours ?? Number.POSITIVE_INFINITY);
      expect(l?.true_odometer).toBeGreaterThan(l?.odometer ?? Number.POSITIVE_INFINITY);
      expect(body.pagination).toEqual({ per_page: 25, page_no: 1, total: 1 });
    }
    const v3 = motiveVehicleLocationsSchema.parse((await get('/v3/vehicle_locations')).body);
    const l3 = v3.vehicles[0]?.vehicle.current_location;
    expect(l3).toMatchObject({ kph: 0, vehicle_state: 'off' }); // H1 is parked at the shop
    expect(l3?.true_engine_hours).toBeUndefined();
    expect(l3?.speed).toBeUndefined();
  });

  test('without X-Metric-Units: false the stand-in answers metric (the ambiguity Motive leaves)', async () => {
    const imperial = motiveVehicleLocationsSchema.parse((await get('/v2/vehicle_locations')).body);
    const metric = motiveVehicleLocationsSchema.parse(
      (await get('/v2/vehicle_locations', { 'x-metric-units': 'true' })).body,
    );
    const mi = imperial.vehicles[0]?.vehicle.current_location?.true_odometer ?? 0;
    const km = metric.vehicles[0]?.vehicle.current_location?.true_odometer ?? 0;
    expect(km / mi).toBeCloseTo(1.609344, 3);
  });

  test('fault codes: knob open → close, top-level paging, the date window', async () => {
    const opened = await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'obd2' });
    expect(opened.status).toBe(200);
    const id = opened.body.faults[0]?.id as string;
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open' });
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'oem' });
    wall += 3 * 60_000;
    const page1 = motiveFaultCodesSchema.parse((await get('/v1/fault_codes?per_page=2')).body);
    expect(page1).toMatchObject({ per_page: 2, page_no: 1, total: 3 });
    expect(page1).not.toHaveProperty('pagination');
    expect(page1.fault_codes[0]?.fault_code).toMatchObject({
      id,
      code: 'P0217',
      status: 'open',
      network: 'obdii',
      first_observed_at: '2026-10-15T14:00:02.000Z',
      last_observed_at: '2026-10-15T14:03:00.000Z',
    });
    const page2 = motiveFaultCodesSchema.parse(
      (await get('/v1/fault_codes?per_page=2&page_no=2')).body,
    );
    expect(page2.fault_codes).toHaveLength(1);
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'close', id });
    const closed = motiveFaultCodesSchema.parse((await get('/v1/fault_codes?status=closed')).body);
    expect(closed.fault_codes.map((f) => f.fault_code.id)).toEqual([id]);
    const none = motiveFaultCodesSchema.parse(
      (await get('/v1/fault_codes?start_date=2026-10-16&end_date=2026-10-20')).body,
    );
    expect(none.fault_codes).toEqual([]);
    expect((await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'close', id: '1' })).status).toBe(
      404,
    );
    expect((await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'clear' })).body.faults).toEqual([]);
  });

  test('vehicles and groups; the gateway knob takes H1 off v3', async () => {
    const vehicles = motiveVehiclesSchema.parse((await get('/v1/vehicles')).body);
    const h1 = vehicles.vehicles[0]?.vehicle;
    expect(h1?.eld_device).not.toBeNull();
    const groups = motiveGroupsSchema.parse((await get('/v1/groups')).body);
    expect(groups.groups.map((g) => [g.group.id, g.group.name])).toEqual([
      [h1?.group_ids?.[0], 'Semi'],
    ]);
    const r = await knob(MOTIVE_SIM_GATEWAY_PATH, { vehicleId: h1?.id, gateway: false });
    expect(r.body.vehicles).toEqual([{ id: h1?.id, unitNo: 'H1', gateway: false }]);
    const v3 = motiveVehicleLocationsSchema.parse((await get('/v3/vehicle_locations')).body);
    expect(v3.vehicles).toEqual([]);
    await knob(MOTIVE_SIM_GATEWAY_PATH, { vehicleId: h1?.id, gateway: null });
    expect(
      motiveVehicleLocationsSchema.parse((await get('/v3/vehicle_locations')).body).vehicles,
    ).toHaveLength(1);
  });

  test('control: bad bodies, unknown paths; reset clears the knobs', async () => {
    expect((await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'explode' })).status).toBe(400);
    expect((await knob(MOTIVE_SIM_GATEWAY_PATH, { gateway: true })).status).toBe(400);
    expect((await knob('/_control/vendor/motive/nope', {})).status).toBe(404);
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open' });
    sim.control.reset({ scenario: 'harvest-day' });
    const res = await fetch(`${sim.url}${MOTIVE_SIM_FAULT_CODES_PATH}`);
    expect(((await res.json()) as MotiveSimStatus).faults).toEqual([]);
  });
});
