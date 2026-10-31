import { describe, expect, test } from 'vitest';
import {
  createReplayFetch,
  matchExchange,
  REPLAY_ORIGIN,
  type ReplayFixture,
  replayBaseUrl,
  replayDeltaMs,
  replayFixtureSchema,
  shiftInstantString,
  shiftInstants,
} from './replay';

const HOUR = 3_600_000;

const fixture: ReplayFixture = {
  format: 1,
  source: 'samsara',
  stream: 'positions',
  kind: 'doc-derived',
  reference: 'https://developers.samsara.com/reference/getvehiclelocationsfeed',
  anchor: '2026-11-30T13:00:00Z',
  exchanges: [
    {
      request: { method: 'GET', path: '/fleet/vehicles/locations/feed', query: { after: 'c2' } },
      response: {
        status: 200,
        body: { data: [], pagination: { endCursor: 'c3', hasNextPage: false } },
      },
    },
    {
      request: { method: 'GET', path: '/fleet/vehicles/locations/feed' },
      response: {
        status: 200,
        body: {
          data: [{ id: 'v1', locations: [{ time: '2026-11-30T12:59:30Z', latitude: 41.9 }] }],
          pagination: { endCursor: 'c2', hasNextPage: true },
        },
      },
    },
  ],
};

describe('time shifting', () => {
  test('RFC 3339 strings move by delta, keeping offset and precision', () => {
    expect(shiftInstantString('2026-11-30T13:00:00Z', HOUR)).toBe('2026-11-30T14:00:00Z');
    expect(shiftInstantString('2026-11-30T13:00:00.250Z', HOUR)).toBe('2026-11-30T14:00:00.250Z');
    expect(shiftInstantString('2026-11-30T08:00:00-05:00', HOUR)).toBe('2026-11-30T09:00:00-05:00');
    expect(shiftInstantString('2026-11-30T23:30:00+00:00', HOUR)).toBe('2026-12-01T00:30:00+00:00');
    expect(shiftInstantString('2026-11-30T13:00Z', 60_000)).toBe('2026-11-30T13:01Z');
  });

  test('interval starts move; dates and other strings do not', () => {
    expect(shiftInstantString('2026-11-30T13:00:00+00:00/PT1H', HOUR)).toBe(
      '2026-11-30T14:00:00+00:00/PT1H',
    );
    expect(shiftInstantString('2026-11-30', HOUR)).toBe('2026-11-30');
    expect(shiftInstantString('v1', HOUR)).toBe('v1');
    expect(shiftInstantString('2026-11-30T13:00:00Z and more', HOUR)).toBe(
      '2026-11-30T13:00:00Z and more',
    );
  });

  test('shiftInstants walks the whole body; epoch keys move too; input untouched', () => {
    const body = {
      a: '2026-11-30T13:00:00Z',
      list: [{ t: '2026-11-30T12:00:00Z', n: 5 }],
      epochMs: 1_000,
      plantedOn: '2026-05-01',
    };
    const out = shiftInstants(body, HOUR, ['epochMs']) as typeof body;
    expect(out).toEqual({
      a: '2026-11-30T14:00:00Z',
      list: [{ t: '2026-11-30T13:00:00Z', n: 5 }],
      epochMs: 1_000 + HOUR,
      plantedOn: '2026-05-01',
    });
    expect(body.a).toBe('2026-11-30T13:00:00Z');
  });

  test('delta is quantized to the fixture step', () => {
    const now = new Date('2026-12-02T09:17:42Z');
    expect(replayDeltaMs(fixture, now) % 60_000).toBe(0);
    expect(replayDeltaMs({ ...fixture, shiftStepSeconds: 3600 }, now) % HOUR).toBe(0);
    expect(replayDeltaMs(fixture, now) <= now.getTime() - Date.parse(fixture.anchor)).toBe(true);
  });
});

describe('the transport', () => {
  test('matches method, path (any host) and required query; first match wins', () => {
    const base = new URL(`${replayBaseUrl('samsara')}/fleet/vehicles/locations/feed`);
    expect(base.origin).toBe(REPLAY_ORIGIN);
    expect(matchExchange([fixture], 'GET', base)?.exchange).toBe(fixture.exchanges[1]);
    base.searchParams.set('after', 'c2');
    expect(matchExchange([fixture], 'GET', base)?.exchange).toBe(fixture.exchanges[0]);
    const realHost = new URL('https://api.samsara.com/fleet/vehicles/locations/feed?after=zz');
    expect(matchExchange([fixture], 'GET', realHost)?.exchange).toBe(fixture.exchanges[1]);
    expect(matchExchange([fixture], 'POST', realHost)).toBeNull();
  });

  test('answers shifted JSON, byte-identical within one step, 404 when nothing matches', async () => {
    let now = new Date('2026-12-02T09:17:42Z');
    const f = createReplayFetch([fixture], { now: () => now });
    const url = `${replayBaseUrl('samsara')}/fleet/vehicles/locations/feed`;
    const a = await (await f(url)).text();
    now = new Date('2026-12-02T09:17:59Z');
    expect(await (await f(url)).text()).toBe(a);
    const body = JSON.parse(a) as { data: { locations: { time: string }[] }[] };
    const t = Date.parse(body.data[0]?.locations[0]?.time ?? '');
    expect(now.getTime() - t).toBeGreaterThanOrEqual(30_000);
    expect(now.getTime() - t).toBeLessThan(30_000 + 60_000);
    const miss = await f(`${replayBaseUrl('samsara')}/nope`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ message: 'replay: no fixture for GET /samsara/nope' });
  });

  test('basePath is stripped before matching', () => {
    const deere: ReplayFixture = {
      ...fixture,
      source: 'deere',
      basePath: '/platform',
      exchanges: [
        { request: { method: 'GET', path: '/organizations' }, response: { status: 200, body: {} } },
      ],
    };
    const u = new URL('https://sandboxapi.deere.com/platform/organizations');
    expect(matchExchange([deere], 'GET', u)).not.toBeNull();
    expect(
      matchExchange([deere], 'GET', new URL(`${replayBaseUrl('deere')}/organizations`)),
    ).not.toBeNull();
  });

  test('a JSON-RPC call is told apart by its body (MyGeotab posts every call to /apiv1)', async () => {
    const rpc = (method: string, typeName?: string) =>
      JSON.stringify({ method, params: { ...(typeName ? { typeName } : {}), fromVersion: '7' } });
    const geotab: ReplayFixture = {
      ...fixture,
      source: 'geotab',
      stream: 'positions',
      exchanges: [
        {
          request: { method: 'POST', path: '/apiv1', body: { method: 'Authenticate' } },
          response: { status: 200, body: { result: { credentials: { sessionId: 's' } } } },
        },
        {
          request: {
            method: 'POST',
            path: '/apiv1',
            body: { method: 'GetFeed', params: { typeName: 'LogRecord' } },
          },
          response: { status: 200, body: { result: { data: ['log'], toVersion: '8' } } },
        },
        {
          request: {
            method: 'POST',
            path: '/apiv1',
            body: { method: 'GetFeed', params: { typeName: 'StatusData' } },
          },
          response: { status: 200, body: { result: { data: ['status'], toVersion: '9' } } },
        },
      ],
    };
    expect(replayFixtureSchema.safeParse(geotab).success).toBe(true);
    const f = createReplayFetch([geotab]);
    const url = `${replayBaseUrl('geotab')}/apiv1`;
    const post = async (body: string) =>
      (
        await f(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      ).json() as Promise<{ result?: { data?: string[] } }>;
    expect((await post(rpc('GetFeed', 'StatusData'))).result?.data).toEqual(['status']);
    expect((await post(rpc('GetFeed', 'LogRecord'))).result?.data).toEqual(['log']);
    expect((await post(rpc('Authenticate'))).result).toHaveProperty('credentials');
    // A Request object works too; an unknown method or a non-JSON body finds nothing.
    const req = new Request(url, { method: 'POST', body: rpc('GetFeed', 'LogRecord') });
    expect(((await (await f(req)).json()) as { result: { data: string[] } }).result.data).toEqual([
      'log',
    ]);
    expect((await f(url, { method: 'POST', body: rpc('GetFeed', 'FaultData') })).status).toBe(404);
    expect((await f(url, { method: 'POST', body: 'not json' })).status).toBe(404);
  });

  test('the fixture schema accepts a well-formed file and refuses a bad one', () => {
    expect(replayFixtureSchema.safeParse(fixture).success).toBe(true);
    expect(replayFixtureSchema.safeParse({ ...fixture, anchor: '2026-11-30' }).success).toBe(false);
    expect(replayFixtureSchema.safeParse({ ...fixture, exchanges: [] }).success).toBe(false);
  });
});
