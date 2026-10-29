/**
 * Contract tests: the LIVE NWS client against (1) the NWS stand-in started in-process (random
 * port, stub world, injectable wall clock) and (2) the doc-derived replay fixtures. The same
 * schemas validate both, and every answer goes through the same mappers.
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { createStubSimWorld, STUB_STARTS_AT } from '../../sim/vendors/stub-world';
import { VendorHttpError } from '../http';
import { NwsClient, pointCoord } from './client';
import { NWS_API_BASE, nwsEndpoint } from './endpoint';
import { mapGridpoint } from './mapper';
import { nwsGridpointSchema } from './schemas';

const UA = 'farm-manager (test@example.com)';
let wall = Date.parse('2026-10-29T12:00:02.000Z');
let sim: VendorSim;
const seen: { url: string; ua: string | null }[] = [];

const spyFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  seen.push({ url: String(input), ua: headers.get('user-agent') });
  return fetch(input, init);
};

function client(mode: 'sim' | 'replay' = 'sim') {
  return NwsClient.forMode(
    mode,
    { VENDOR_SIM_URL: sim.url, NWS_USER_AGENT: UA },
    {
      now: () => new Date(wall),
      timeoutMs: 5000,
      sleep: async () => {},
      ...(mode === 'sim' ? { fetch: spyFetch } : {}),
    },
  );
}

async function control(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${sim.url}/_control/vendor/nws/weather`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as Record<string, unknown>) };
}

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createStubSimWorld,
    port: 0,
    now: () => new Date(wall),
  });
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = Date.parse('2026-10-29T12:00:02.000Z');
  sim.control.reset({ scenario: 'harvest-day' });
  seen.length = 0;
});

describe('endpoints', () => {
  test('sim -> the stand-in; live and sandbox -> api.weather.gov; off refuses', () => {
    const cfg = { VENDOR_SIM_URL: 'http://127.0.0.1:4015/', NWS_USER_AGENT: UA };
    expect(nwsEndpoint('sim', cfg).baseUrl).toBe('http://127.0.0.1:4015/nws');
    expect(nwsEndpoint('live', cfg).baseUrl).toBe(NWS_API_BASE);
    expect(nwsEndpoint('sandbox', cfg).baseUrl).toBe(NWS_API_BASE);
    expect(nwsEndpoint('replay', cfg).fetch).toBeTypeOf('function');
    expect(() => nwsEndpoint('off', cfg)).toThrow(/does not poll/);
    expect(pointCoord(41.897641)).toBe('41.8976');
    expect(pointCoord(-84)).toBe('-84');
  });
});

describe('NWS client against the stand-in (sim)', () => {
  test('gridFor: /points then the cell stations, nearest first; the User-Agent is sent', async () => {
    const { grid, stations } = await client().gridFor(-84.0312345, 41.8976543);
    expect(grid).toMatchObject({ wfo: 'DTX' });
    expect(grid.id).toBe(`DTX/${grid.x},${grid.y}`);
    expect(stations[0]?.id).toBe('KADG');
    expect(stations.map((s) => s.id)).toHaveLength(4);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/nws/points/41.8977,-84.0312',
      `/nws/gridpoints/DTX/${grid.x},${grid.y}/stations`,
    ]);
    expect(seen.every((s) => s.ua === UA)).toBe(true);
  });

  test('a request without a User-Agent is refused (403, problem+json)', async () => {
    const res = await new Promise<{ status: number; type: string; body: string }>(
      (resolve, reject) => {
        const req = http.request(`${sim.url}/nws/points/41.9,-84.03`, (r) => {
          let body = '';
          r.on('data', (c) => {
            body += c;
          });
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, type: String(r.headers['content-type']), body }),
          );
        });
        req.on('error', reject);
        req.end();
      },
    );
    expect(res.status).toBe(403);
    expect(res.type).toMatch(/application\/problem\+json/);
    expect(JSON.parse(res.body)).toMatchObject({ status: 403, title: 'Forbidden' });
  });

  test('hourly: a week of hours in US units, every layer present, validated by the schema', async () => {
    const c = client();
    const { grid } = await c.gridFor(-84.03, 41.9);
    const raw = await c.gridpoint(grid);
    expect(nwsGridpointSchema.safeParse(raw).success).toBe(true);
    expect(raw.geometry?.type).toBe('Polygon');
    const issue = mapGridpoint(raw);
    expect(issue.grid).toEqual(grid);
    expect(issue.hours).toHaveLength(7 * 24);
    expect(Date.parse(issue.issuedAt)).toBeLessThanOrEqual(wall);
    for (let i = 1; i < issue.hours.length; i++) {
      expect(
        Date.parse(issue.hours[i]?.validAt ?? '') - Date.parse(issue.hours[i - 1]?.validAt ?? ''),
      ).toBe(3_600_000);
    }
    for (const h of issue.hours) {
      expect(h.tempF).toBeGreaterThan(20);
      expect(h.tempF).toBeLessThan(90);
      expect(h.windMph).not.toBeNull();
      expect(h.gustMph ?? 0).toBeGreaterThanOrEqual(h.windMph ?? 0);
      expect(h.popPct).not.toBeNull();
      expect(h.qpfIn).toBe(0); // harvest-day is calm and dry
      expect(h.mixingHeightFt).toBeGreaterThan(0);
      expect(h.transportWindMph).not.toBeNull();
    }
  });

  test('one issue per sim hour; the wind slider starts a new issue with the pinned wind', async () => {
    const c = client();
    const { grid } = await c.gridFor(-84.03, 41.9);
    const first = await c.hourly(grid);
    wall += 10 * 60_000; // same sim hour (speed 1, scenario starts 07:00 sharp)
    const again = await c.hourly(grid);
    expect(again).toEqual(first);
    wall += 60 * 60_000; // the sim crossed an hour
    const next = await c.hourly(grid);
    expect(Date.parse(next.issuedAt)).toBeGreaterThan(Date.parse(first.issuedAt));

    wall += 1_000;
    const st = await control({ windMph: 18 });
    expect(st).toMatchObject({ status: 200, windMph: 18, effectivePattern: 'calm' });
    const windy = await c.hourly(grid);
    expect(windy.issuedAt).toBe(new Date(Math.floor(wall / 1000) * 1000).toISOString());
    for (const h of windy.hours) {
      expect(h.windMph).toBeGreaterThan(17);
      expect(h.windMph).toBeLessThan(19);
      expect(h.gustMph).toBeGreaterThan(23);
    }
    wall += 1_000;
    await control({ windMph: null });
    const calm = await c.hourly(grid);
    expect(Math.max(...calm.hours.map((h) => h.windMph ?? 0))).toBeLessThan(8);
  });

  test('patterns: rain overnight, wind up mid-morning', async () => {
    const c = client();
    const { grid } = await c.gridFor(-84.03, 41.9);
    await control({ pattern: 'overnight-rain' });
    const rain = await c.hourly(grid);
    expect(rain.hours.some((h) => (h.popPct ?? 0) >= 80)).toBe(true);
    expect(rain.hours.reduce((s, h) => s + (h.qpfIn ?? 0), 0)).toBeGreaterThan(0.5);
    await control({ pattern: 'windy-morning' });
    const windy = await c.hourly(grid);
    expect(Math.max(...windy.hours.map((h) => h.windMph ?? 0))).toBeGreaterThan(15);
    expect(Math.min(...windy.hours.map((h) => h.windMph ?? 99))).toBeLessThan(5);
    expect((await control({ pattern: 'hail' })).status).toBe(400);
    expect((await control({ windMph: 99 })).status).toBe(400);
  });

  test('observations: on the 20-minute grid, after `since`, oldest first, in US units', async () => {
    const c = client();
    const since = new Date(wall - 61 * 60_000);
    const obs = await c.observations('KADG', since);
    expect(obs.map((o) => o.observedAt)).toEqual([
      '2026-10-29T11:00:00.000Z',
      '2026-10-29T11:20:00.000Z',
      '2026-10-29T11:40:00.000Z',
      '2026-10-29T12:00:00.000Z',
    ]);
    for (const o of obs) {
      expect(o).toMatchObject({ stationId: 'KADG', lng: -84.0773, lat: 41.8676 });
      expect(o.windMph).toBeGreaterThanOrEqual(0);
      expect(o.tempF).toBeGreaterThan(20);
    }
    const later = await c.observations('KADG', new Date(Date.parse('2026-10-29T12:00:00Z')));
    expect(later).toEqual([]);
  });

  test('errors: unknown cell and station are NWS 404s', async () => {
    const c = client();
    await expect(c.hourly({ id: 'LOT/1,1', wfo: 'LOT', x: 1, y: 1 })).rejects.toBeInstanceOf(
      VendorHttpError,
    );
    await expect(c.observations('KXXX', new Date(wall - 3_600_000))).rejects.toMatchObject({
      status: 404,
    });
  });

  test('the stand-in follows the sim clock: STUB_STARTS_AT is 07:00 in Adrian', async () => {
    const st = await control(undefined);
    expect(st).toMatchObject({ status: 200, scenario: 'harvest-day', defaultPattern: 'calm' });
    expect(Date.parse(String(st.simNow))).toBeGreaterThanOrEqual(STUB_STARTS_AT.getTime());
  });
});

describe('NWS client in replay (doc-derived fixtures)', () => {
  test('any point answers the fixture cell; stations nearest first', async () => {
    const { grid, stations } = await client('replay').gridFor(-83.66, 41.95);
    expect(grid).toEqual({ id: 'DTX/31,40', wfo: 'DTX', x: 31, y: 40 });
    expect(stations.map((s) => s.id)).toEqual(['KTTF', 'KADG', 'KTOL']);
  });

  test('the forecast shifts by whole hours, keeps absent layers null and spreads QPF', async () => {
    wall = Date.parse('2026-10-29T14:30:00Z'); // 2.5 h after the anchor -> +2 h
    const c = client('replay');
    const issue = await c.hourly({ id: 'DTX/31,40', wfo: 'DTX', x: 31, y: 40 });
    expect(issue.issuedAt).toBe('2026-10-29T13:42:31.000Z');
    expect(issue.hours[0]?.validAt).toBe('2026-10-29T08:00:00.000Z');
    expect(issue.hours).toHaveLength(7 * 24);
    expect(issue.hours.every((h) => h.transportWindMph === null)).toBe(true);
    expect(issue.hours.slice(0, 8).every((h) => h.gustMph === null)).toBe(true);
    // 6.35 mm over 6 hours: 0.042 in an hour.
    expect(issue.hours.some((h) => h.qpfIn === 0.042)).toBe(true);
  });

  test('observations of every listed station', async () => {
    const c = client('replay');
    for (const id of ['KADG', 'KTTF', 'KTOL']) {
      const obs = await c.observations(id, new Date(wall - 24 * 3_600_000));
      expect(obs).toHaveLength(6);
      expect(obs[0]?.stationId).toBe(id);
      expect(obs.at(-1)?.observedAt).toBe('2026-10-29T11:53:00.000Z');
    }
  });
});
