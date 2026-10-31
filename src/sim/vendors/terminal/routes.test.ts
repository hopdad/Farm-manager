/**
 * The Terminal stand-in on its own: Terminal's flat error body, /providers with no key, the
 * Connection-Token per hauler, `{ results, next? }` paging, the 50-id cap, H3 on its 10 s grid
 * (no jitter, still while the simulation is paused), Terminal's sync lag, and the knobs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS, SIM_TERMINAL_CONNECTION_ID, simTelematicsMachines } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  SIM_TERMINAL_GONE_CONNECTION_ID,
  TERMINAL_SIM_FAULT_CODES_PATH,
  TERMINAL_SIM_RATE_LIMIT_PATH,
  type TerminalSimStatus,
} from './control-types';

let wall = Date.parse('2026-10-15T14:00:04.000Z');
let sim: VendorSim;
let h3: string;

const KEY = { authorization: `Bearer ${SIM_CREDENTIALS.terminal.secretKey}` };
const TOKEN = { ...KEY, 'connection-token': SIM_CREDENTIALS.terminal.connectionToken };

async function get(path: string, headers: Record<string, string> = TOKEN) {
  const res = await fetch(`${sim.url}/terminal/tsp/v1${path}`, { headers });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}
async function knob(path: string, body: unknown) {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as TerminalSimStatus & { error?: string } };
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  h3 = simTelematicsMachines(sim.world.farm, 'terminal')[0]?.telematics?.id as string;
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = Date.parse('2026-10-15T14:00:04.000Z');
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('the Terminal stand-in', () => {
  test("errors are Terminal's flat body; /providers needs no key; the rest needs the secret key", async () => {
    const providers = await fetch(`${sim.url}/terminal/tsp/v1/providers`);
    expect(providers.status).toBe(200);
    const list = (await providers.json()) as { code: string }[];
    expect(list.map((p) => p.code)).toContain('omnitracs-xrs');

    expect(await get('/connections', {})).toMatchObject({
      status: 401,
      body: {
        code: 'unauthorized',
        message: 'Unauthorized Request',
        detail: 'Must authenticate with an application to perform this operation',
      },
    });
    expect(await get('/vehicles', KEY)).toMatchObject({
      status: 401,
      body: { code: 'unauthorized', detail: 'The Connection-Token header is required' },
    });
    expect((await get('/nope')).body).toMatchObject({ code: 'not_found' });
    expect((await get(`/vehicles/vcl_nobody/locations`)).status).toBe(404);
    const post = await fetch(`${sim.url}/terminal/tsp/v1/vehicles`, {
      method: 'POST',
      headers: TOKEN,
    });
    expect(post.status).toBe(405);
  });

  test('connections: every row with its token; ?status filters (the second hauler left)', async () => {
    const all = await get('/connections', KEY);
    const rows = all.body.results as { id: string; status: string; token: string }[];
    expect(rows.map((c) => [c.id, c.status])).toEqual([
      [SIM_TERMINAL_CONNECTION_ID, 'connected'],
      [SIM_TERMINAL_GONE_CONNECTION_ID, 'disconnected'],
    ]);
    expect(rows[0]?.token).toBe(SIM_CREDENTIALS.terminal.connectionToken);
    const connected = await get('/connections?status=connected', KEY);
    expect((connected.body.results as unknown[]).length).toBe(1);
    expect((await get('/connections/current')).body).toMatchObject({
      id: SIM_TERMINAL_CONNECTION_ID,
    });
  });

  test('paging follows `next`; limit and the 50-id cap are checked', async () => {
    const first = await get(`/vehicles/${h3}/locations?limit=50`);
    expect((first.body.results as unknown[]).length).toBe(50);
    expect(typeof first.body.next).toBe('string');
    let total = 50;
    let next = first.body.next as string | undefined;
    while (next) {
      const p = await get(`/vehicles/${h3}/locations?limit=50&cursor=${next}`);
      total += (p.body.results as unknown[]).length;
      next = p.body.next as string | undefined;
    }
    // 30 min kept, every 10 s, the newest 10 s not stored yet: 13:30:10 … 13:59:50.
    expect(total).toBe(179);
    expect((await get(`/vehicles/${h3}/locations?limit=0`)).body).toMatchObject({
      code: 'bad_request',
    });
    const many = Array.from({ length: 51 }, (_, i) => `vcl_${i}`).join(',');
    expect((await get(`/vehicles/locations?vehicleIds=${many}`)).status).toBe(400);
  });

  test('H3 on the 10 s grid with no jitter; still while the simulation is paused; latest ahead of history', async () => {
    const latest = async () =>
      (
        (await get('/vehicles/locations')).body.results as {
          locatedAt: string;
          location: { latitude: number; longitude: number };
        }[]
      )[0];
    const a = await latest();
    expect(a?.locatedAt).toBe('2026-10-15T14:00:00.000Z');
    sim.control.clock({ action: 'pause' });
    wall += 30_000;
    const b = await latest();
    expect(b?.locatedAt).toBe('2026-10-15T14:00:30.000Z');
    expect(b?.location).toEqual(a?.location);
    const hist = (await get(`/vehicles/${h3}/locations?startAt=2026-10-15T14:00:00Z`)).body
      .results as { locatedAt: string; metadata: { modifiedAt: string } }[];
    expect(hist.map((h) => h.locatedAt.slice(11, 19))).toEqual([
      '14:00:00',
      '14:00:10',
      '14:00:20',
    ]);
    expect(hist.map((h) => h.metadata.modifiedAt.slice(11, 19))).toEqual([
      '14:00:10',
      '14:00:20',
      '14:00:30',
    ]);
  });

  test('stat logs only of the types the provider has (no fuel for Omnitracs XRS), metric', async () => {
    const r = await get(
      `/vehicles/${h3}/stats/historical?types=odometer,fuel_level,engine_runtime`,
    );
    const types = new Set((r.body.results as { type: string }[]).map((x) => x.type));
    expect(types).toEqual(new Set(['odometer', 'engine_runtime']));
  });

  test('knobs: fault events, a fractional Retry-After, and a bad request', async () => {
    expect(
      (await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'obdii' })).status,
    ).toBe(200);
    wall += 10_000;
    const ev = await get('/fault-codes/events');
    expect(
      (ev.body.results as { code: string; protocol: string }[]).map((e) => [e.protocol, e.code]),
    ).toEqual([['obdii', 'P0217']]);
    expect(
      (await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'close', code: 'nope' })).status,
    ).toBe(400);

    await knob(TERMINAL_SIM_RATE_LIMIT_PATH, { count: 1, retryAfter: '0.62' });
    const limited = await get('/vehicles');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('0.62');
    expect(limited.body).toMatchObject({ code: 'too_many_requests', retryAfter: 1 });
    expect((await get('/vehicles')).status).toBe(200);
  });
});
