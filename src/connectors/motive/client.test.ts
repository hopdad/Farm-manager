/**
 * MotiveClient against a fake Motive (doc-shaped pages): the snapshot-diff cursors (a watermark
 * per vehicle, so a truck whose gateway reports a little later than another's is not dropped:
 * review repro A at 12:00:05, B at 12:00:03, then B 12:00:04), v3 for gateway units and v2 for
 * the rest, the headers, Motive's two paging styles, the lenient per-item parse, `only`, and a
 * 429 "Retry after N seconds" message.
 */
import { describe, expect, test } from 'vitest';
import { VendorHttpError } from '../http';
import { parseSnapshotCursor } from '../sync-models';
import { MotiveClient } from './client';

type Route = (url: URL, call: number) => Response | Promise<Response>;

let hosts = 0;
function fakeMotive(
  routes: Record<string, Route>,
  opts: ConstructorParameters<typeof MotiveClient>[2] = {},
) {
  const sent: { url: URL; headers: Headers }[] = [];
  const calls = new Map<string, number>();
  const base = `http://127.0.0.1:1/motive-${++hosts}`;
  const fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    sent.push({ url, headers: new Headers(init?.headers) });
    const path = url.pathname.replace(/^\/motive-\d+/, '');
    const n = calls.get(path) ?? 0;
    calls.set(path, n + 1);
    const route = routes[path];
    if (route) return route(url, n);
    if (path === '/v1/companies') {
      return Response.json({ companies: [{ company: { id: 285945, company_id: 'KT1607533' } }] });
    }
    if (path === '/v3/vehicle_locations' || path === '/v2/vehicle_locations') {
      return Response.json({ vehicles: [], pagination: { per_page: 100, page_no: 1, total: 0 } });
    }
    return Response.json({ error_message: 'not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  const client = new MotiveClient(
    { baseUrl: base, apiKey: 'k' },
    { fetch, timeoutMs: 1000, baseBackoffMs: 1, sleep: async () => {} },
    opts,
  );
  return { client, sent, calls };
}

const loc = (at: string, extra: Record<string, unknown> = {}) => ({
  lat: 41.9,
  lon: -84,
  bearing: 90,
  speed: 50,
  located_at: at,
  ...extra,
});
const page = (vehicles: unknown[], p = { per_page: 100, page_no: 1, total: vehicles.length }) =>
  Response.json({ vehicles, pagination: p });
const ids = (r: { items: { externalId: string }[] }) => r.items.map((i) => i.externalId);

describe('MotiveClient.pollPositions', () => {
  test('each vehicle has its own watermark', async () => {
    const located = [
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:03Z' },
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:04Z' },
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:04Z' },
    ];
    const { client, sent } = fakeMotive({
      '/v2/vehicle_locations': (_u, n) =>
        page(
          Object.entries(located[Math.min(n, 2)] as Record<string, string>).map(([id, at]) => ({
            vehicle: { id, number: `T${id}`, current_location: loc(at) },
          })),
        ),
    });
    const first = await client.pollPositions(null);
    expect(ids(first)).toEqual(['A:2026-10-29T12:00:05.000Z', 'B:2026-10-29T12:00:03.000Z']);
    const second = await client.pollPositions(first.cursor);
    expect(ids(second)).toEqual(['B:2026-10-29T12:00:04.000Z']); // A unchanged, B newer
    const third = await client.pollPositions(second.cursor);
    expect(ids(third)).toEqual([]);
    expect(parseSnapshotCursor(third.cursor).seen).toEqual({
      A: String(Date.parse('2026-10-29T12:00:05Z')),
      B: String(Date.parse('2026-10-29T12:00:04Z')),
    });
    // Imperial units asked for explicitly (Motive's default is ambiguous), the key in a header.
    for (const s of sent) {
      expect(s.headers.get('x-metric-units')).toBe('false');
      expect(s.headers.get('x-api-key')).toBe('k');
      expect(s.url.search).not.toContain('k=');
    }
    expect(first.items[0]?.payload).toMatchObject({ companyId: '285945', api: 'v2' });
  });

  test('a 1a cursor (one map of ISO times) starts over once; a broken one too', async () => {
    const { client } = fakeMotive({
      '/v2/vehicle_locations': () =>
        page([{ vehicle: { id: 'A', current_location: loc('2026-10-29T12:00:05Z') } }]),
    });
    for (const old of ['{"A":"2026-10-29T12:00:05.000Z"}', '2026-10-29T12:00:05Z', '{oops', '']) {
      expect(ids(await client.pollPositions(old))).toEqual(['A:2026-10-29T12:00:05.000Z']);
    }
  });

  test('v3 for Vehicle Gateway units (kph, vehicle_state), v2 for every other vehicle', async () => {
    const { client } = fakeMotive({
      '/v3/vehicle_locations': () =>
        page([
          {
            vehicle: {
              id: 998707,
              number: 'H1',
              current_location: {
                lat: 41.86,
                lon: -83.81,
                bearing: null,
                located_at: '2026-10-29T12:00:05Z',
                kph: 80.5,
                vehicle_state: 'on',
                current_location: '18th Street West',
              },
            },
          },
        ]),
      '/v2/vehicle_locations': () =>
        page([
          { vehicle: { id: 998707, number: 'H1', current_location: loc('2026-10-29T12:00:00Z') } },
          { vehicle: { id: 23, number: 'V-1000', current_location: loc('2026-10-29T12:00:01Z') } },
          { vehicle: { id: 24, number: 'parked, no fix', current_location: null } },
        ]),
    });
    const r = await client.asTelematicsSource().positions(null);
    expect(r.items).toEqual([
      expect.objectContaining({
        externalMachineId: '998707',
        sourceOrg: '285945',
        speedMph: 50, // 80.5 km/h
        heading: null,
        engineOn: true,
        ts: '2026-10-29T12:00:05.000Z',
      }),
      expect.objectContaining({
        externalMachineId: '23',
        speedMph: 50, // v2: mph as sent
        engineOn: null,
        heading: 90,
      }),
    ]);
  });

  test('v3 refused (403/404): every vehicle from v2, logged', async () => {
    const log: string[] = [];
    const { client } = fakeMotive(
      {
        '/v3/vehicle_locations': () =>
          Response.json({ error_message: 'forbidden' }, { status: 403 }),
        '/v2/vehicle_locations': () =>
          page([{ vehicle: { id: 7, current_location: loc('2026-10-29T12:00:00Z') } }]),
      },
      { log: (m) => log.push(m) },
    );
    expect(ids(await client.pollPositions(null))).toEqual(['7:2026-10-29T12:00:00.000Z']);
    expect(log.join('\n')).toMatch(/v3 vehicle_locations refused/);
  });

  test('paging: per_page 100, stop when page_no × per_page ≥ total', async () => {
    const { client, sent } = fakeMotive({
      '/v2/vehicle_locations': (u) => {
        const n = Number(u.searchParams.get('page_no'));
        const vehicles = Array.from({ length: n < 3 ? 100 : 50 }, (_, i) => ({
          vehicle: { id: n * 1000 + i, current_location: loc('2026-10-29T12:00:00Z') },
        }));
        return page(vehicles, { per_page: 100, page_no: n, total: 250 });
      },
    });
    const r = await client.pollPositions(null);
    expect(r.items).toHaveLength(250);
    const v2 = sent.filter((s) => s.url.pathname.endsWith('/v2/vehicle_locations'));
    expect(v2.map((s) => s.url.searchParams.get('page_no'))).toEqual(['1', '2', '3']);
    expect(v2.every((s) => s.url.searchParams.get('per_page') === '100')).toBe(true);
  });

  test('one unreadable vehicle is dropped and logged with its id, never the page', async () => {
    const log: unknown[] = [];
    const { client } = fakeMotive(
      {
        '/v2/vehicle_locations': () =>
          page([
            { vehicle: { id: 1, current_location: loc('2026-10-29T12:00:00Z') } },
            { vehicle: { id: 2, current_location: { lat: 'north', lon: -84 } } },
            { vehicle: { id: 3, current_location: loc('2026-10-29T12:00:00Z') } },
          ]),
      },
      { log: (msg, data) => log.push({ msg, data }) },
    );
    expect(ids(await client.pollPositions(null))).toEqual([
      '1:2026-10-29T12:00:00.000Z',
      '3:2026-10-29T12:00:00.000Z',
    ]);
    expect(log).toEqual([
      { msg: 'motive: unreadable item dropped', data: { path: '/v2/vehicle_locations', id: '2' } },
    ]);
  });

  test('`only`: vehicles the farm does not map never leave the client', async () => {
    const { client } = fakeMotive(
      {
        '/v2/vehicle_locations': () =>
          page([
            { vehicle: { id: 1, current_location: loc('2026-10-29T12:00:00Z') } },
            { vehicle: { id: 2, current_location: loc('2026-10-29T12:00:00Z') } },
          ]),
      },
      { only: new Set(['2']) },
    );
    expect(ids(await client.pollPositions(null))).toEqual(['2:2026-10-29T12:00:00.000Z']);
  });

  test("a 429 with Motive's 'Retry after N seconds' body carries retryAfterSeconds", async () => {
    const { client } = fakeMotive({
      '/v1/companies': () =>
        Response.json({ error: 'Rate limit exceeded, Retry after 7 seconds' }, { status: 429 }),
    });
    const err = await client.pollPositions(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });
});

describe('MotiveClient stats, faults, vehicles', () => {
  test('stats from v2 current_location: emitted when they change, sharing the positions read', async () => {
    let hours = 13_410.4;
    const { client, calls } = fakeMotive({
      '/v2/vehicle_locations': () =>
        page([
          {
            vehicle: {
              id: 5,
              current_location: loc('2026-10-29T12:00:00Z', {
                true_engine_hours: hours,
                engine_hours: hours - 12.5,
                true_odometer: 488_210.2,
                odometer: 486_689.9,
                fuel_primary_remaining_percentage: 64.5,
              }),
            },
          },
          // no stats at all: nothing to report
          { vehicle: { id: 6, current_location: loc('2026-10-29T12:00:00Z') } },
        ]),
    });
    await client.pollPositions(null);
    const first = await client.pollStats(null);
    expect(calls.get('/v2/vehicle_locations')).toBe(1); // reused within the run
    expect(ids(first)).toEqual(['5:stats:2026-10-29T12:00:00.000Z']);
    const same = await client.pollStats(first.cursor);
    expect(same.items).toEqual([]);
    hours += 0.1;
    await client.pollPositions(null);
    expect(ids(await client.pollStats(same.cursor))).toHaveLength(1);
  });

  test('fault codes: top-level paging, a 7-day window, delta items when status or time moves', async () => {
    const record = (id: number, status: string, last: string) => ({
      fault_code: {
        id,
        code: 'P0217',
        code_label: 'P0217',
        status,
        first_observed_at: '2026-10-29T11:00:00Z',
        last_observed_at: last,
        network: 'obdii',
        vehicle: { id: 5, number: 'H1' },
      },
    });
    let status = 'open';
    const { client, sent } = fakeMotive({
      '/v1/fault_codes': (u) => {
        const n = Number(u.searchParams.get('page_no'));
        const items =
          n === 1
            ? Array.from({ length: 100 }, (_, i) =>
                record(1000 + i, 'closed', '2026-10-28T10:00:00Z'),
              )
            : [record(7, status, '2026-10-29T12:00:00Z'), { fault_code: { id: 8 } }];
        return Response.json({ fault_codes: items, per_page: 100, page_no: n, total: 102 });
      },
    });
    const first = await client.pollFaults(null);
    expect(first.items).toHaveLength(101);
    const req = sent.find((s) => s.url.pathname.endsWith('/v1/fault_codes'));
    expect(req?.url.searchParams.get('start_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(req?.url.searchParams.get('end_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.filter((s) => s.url.pathname.endsWith('/v1/fault_codes'))).toHaveLength(2);
    expect((await client.pollFaults(first.cursor)).items).toEqual([]);
    status = 'closed';
    const closed = await client.pollFaults(first.cursor);
    expect(ids(closed)).toEqual(['5:fault:7:closed:2026-10-29T12:00:00.000Z']);
  });

  test('vehicles: group names as tags, emitted once per change', async () => {
    let groups = [11];
    const { client } = fakeMotive({
      '/v1/vehicles': () =>
        page([
          {
            vehicle: {
              id: 939680,
              number: 'H1',
              make: 'Kenworth',
              model: 'T880',
              year: '2020',
              vin: '',
              group_ids: groups,
            },
          },
        ]),
      '/v1/groups': () =>
        Response.json({
          groups: [
            { group: { id: 11, name: 'Semi' } },
            { group: { id: 12, name: 'Service truck' } },
          ],
        }),
    });
    const first = await client.pollVehicles(null);
    expect(first.items[0]?.payload).toMatchObject({ companyId: '285945', groups: ['Semi'] });
    expect((await client.pollVehicles(first.cursor)).items).toEqual([]);
    groups = [12];
    const v = await client.asTelematicsSource().vehicles();
    expect(v).toEqual([
      expect.objectContaining({
        externalId: '939680',
        kindFromTags: 'service_truck',
        via: null,
        year: 2020,
        vin: null,
      }),
    ]);
    expect((await client.pollVehicles(first.cursor)).items).toHaveLength(1);
  });
});
