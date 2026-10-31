/**
 * The Samsara stand-in's vehicle list (GET /fleet/vehicles): Samsara's page shape with
 * `endCursor` / `hasNextPage`, the 512 limit, the token check (the core router's), and the
 * re-tag knob.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  SAMSARA_SIM_VEHICLE_TAGS_PATH,
  type SamsaraVehiclesSimStatus,
} from './vehicles-routes-control';

let sim: VendorSim;
const AUTH = { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}` };

async function get(query = '', headers: Record<string, string> = AUTH) {
  const res = await fetch(`${sim.url}/samsara/fleet/vehicles${query}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createSimWorld,
    port: 0,
    now: () => new Date('2026-10-15T14:00:00Z'),
  });
});
afterAll(() => sim.close());
beforeEach(() => sim.control.reset({ scenario: 'harvest-day' }));

describe('Samsara stand-in: GET /fleet/vehicles', () => {
  test('pages with endCursor / hasNextPage; the last page has an empty endCursor', async () => {
    const first = await get('?limit=4');
    const data = first.body.data as { name: string }[];
    expect(data.map((v) => v.name)).toEqual(['S1', 'S2', 'S3', 'S4']);
    const p = first.body.pagination as { endCursor: string; hasNextPage: boolean };
    expect(p.hasNextPage).toBe(true);
    const second = await get(`?limit=4&after=${p.endCursor}`);
    expect((second.body.data as { name: string }[]).map((v) => v.name)).toEqual(['PU1', 'PU2']);
    expect(second.body.pagination).toEqual({ endCursor: '', hasNextPage: false });
  });

  test('limit is checked, the token too, and only GET is served', async () => {
    expect((await get('?limit=513')).status).toBe(400);
    expect((await get('?after=@@')).status).toBe(400);
    expect((await get('', {})).status).toBe(401);
    const post = await fetch(`${sim.url}/samsara/fleet/vehicles`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(post.status).toBe(405);
  });

  test('the knob re-tags a vehicle and goes back to the world', async () => {
    const status = async (body: unknown) => {
      const res = await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as SamsaraVehiclesSimStatus };
    };
    const before = (await fetch(`${sim.url}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`).then((r) =>
      r.json(),
    )) as SamsaraVehiclesSimStatus;
    const pu1 = before.vehicles.find((v) => v.unitNo === 'PU1');
    expect(pu1).toMatchObject({ tags: ['Pickup'], overridden: false });
    const set = await status({ vehicleId: pu1?.id, tags: ['Service truck'] });
    expect(set.body.vehicles.find((v) => v.id === pu1?.id)).toMatchObject({
      tags: ['Service truck'],
      overridden: true,
    });
    const listed = (await get()).body.data as { id: string; tags: { name: string }[] }[];
    expect(listed.find((v) => v.id === pu1?.id)?.tags.map((t) => t.name)).toEqual([
      'Service truck',
    ]);
    await status({ vehicleId: pu1?.id, tags: null });
    expect(
      ((await get()).body.data as { id: string; tags: { name: string }[] }[])
        .find((v) => v.id === pu1?.id)
        ?.tags.map((t) => t.name),
    ).toEqual(['Pickup']);
    expect((await status({ vehicleId: 'nope', tags: [] })).status).toBe(400);
  });
});
