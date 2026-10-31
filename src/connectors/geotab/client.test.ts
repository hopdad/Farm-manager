/**
 * GeotabClient against a fake MyGeotab (JSON-RPC, errors as HTTP 200 with `error.data.type`):
 * Authenticate (`userName` on the wire, once per session, reused across clients through the
 * store, again on InvalidUserException), LoginResult.path (a host, "ThisServer", absent; a dead
 * stored server), the client-side limits (Authenticate 10/min, GetFeed 60/min per entity type)
 * and a server OverLimitException with Retry-After, StatusData filtered before landing, the
 * limited-scope fallback, and lenient per-item parsing.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryTokenStore } from '../oauth/memory-store';
import { GeotabClient, GeotabError, resetGeotabCaches } from './client';
import { decodeSession, resetGeotabLimits, serverFromPath } from './session';

interface Call {
  host: string;
  method: string;
  params: Record<string, unknown>;
}
type Handler = (
  call: Call,
  n: number,
) =>
  | { result?: unknown; error?: string; message?: string; headers?: Record<string, string> }
  | 'network';

let wall = Date.parse('2026-10-30T15:00:00.000Z');
const endpoint = {
  apiUrl: 'https://my.geotab.com/apiv1',
  server: 'my.geotab.com',
  database: 'acme',
  username: 'svc-farm',
  password: 'pw',
};

function fake(handler: Handler, opts: ConstructorParameters<typeof GeotabClient>[2] = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    const call = { host: url.host, method: body.method, params: body.params };
    calls.push(call);
    const r = handler(call, n++);
    if (r === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (r.error) {
      return Response.json(
        {
          error: { code: -32000, message: r.message ?? r.error, data: { type: r.error } },
          jsonrpc: '2.0',
        },
        { headers: r.headers },
      );
    }
    return Response.json({ result: r.result, jsonrpc: '2.0' }, { headers: r.headers });
  }) as typeof globalThis.fetch;
  const store = opts.store ?? new MemoryTokenStore('geotab', null, { now: () => new Date(wall) });
  const client = new GeotabClient(
    endpoint,
    { fetch, now: () => new Date(wall), timeoutMs: 1000, maxRetries: 0, sleep: async () => {} },
    { ...opts, store },
  );
  return { client, calls, store };
}

let sessions = 0;
const login = (path?: string | null) => ({
  result: {
    credentials: { database: 'acme', userName: 'svc-farm', sessionId: `s${++sessions}` },
    ...(path === undefined ? { path: 'ThisServer' } : path === null ? {} : { path }),
  },
});
const feed = (data: unknown[], toVersion: string) => ({ result: { data, toVersion } });

beforeEach(() => {
  resetGeotabLimits();
  resetGeotabCaches();
  wall += 3_600_000;
});

describe('Geotab session', () => {
  test('Authenticate sends `userName`; one session serves many calls and the next client', async () => {
    const { client, calls, store } = fake((c) =>
      c.method === 'Authenticate' ? login() : feed([], '0000000000000010'),
    );
    await client.getFeed('LogRecord', null);
    await client.getFeed('StatusData', null);
    const auth = calls.filter((c) => c.method === 'Authenticate');
    expect(auth).toHaveLength(1);
    expect(auth[0]?.params).toEqual({ database: 'acme', userName: 'svc-farm', password: 'pw' });
    expect(calls[1]?.params.credentials).toEqual({
      database: 'acme',
      userName: 'svc-farm',
      sessionId: `s${sessions}`,
    });
    expect(JSON.stringify(calls.slice(1))).not.toContain('"pw"');
    // A new client (the next run) reuses the stored session: no second Authenticate.
    const next = fake(
      (c) => (c.method === 'Authenticate' ? login() : feed([], '0000000000000011')),
      { store },
    );
    await next.client.getFeed('LogRecord', '0000000000000010');
    expect(next.calls.map((c) => c.method)).toEqual(['GetFeed']);
  });

  test('InvalidUserException (expired, password changed, server restarted): authenticate again, retry once', async () => {
    let expired = true;
    const { client, calls } = fake((c) => {
      if (c.method === 'Authenticate') return login();
      if (expired && (c.params.credentials as { sessionId: string }).sessionId === `s${sessions}`) {
        expired = false;
        return { error: 'InvalidUserException', message: "Invalid session @ 'acme'" };
      }
      return feed([], '00000000000000aa');
    });
    await client.session();
    const r = await client.getFeed('LogRecord', null);
    expect(r.toVersion).toBe('00000000000000aa');
    expect(calls.map((c) => c.method)).toEqual([
      'Authenticate',
      'GetFeed',
      'Authenticate',
      'GetFeed',
    ]);
  });

  test('a bad password: the InvalidUserException surfaces (no loop)', async () => {
    const { client, calls } = fake(() => ({
      error: 'InvalidUserException',
      message: 'Incorrect login credentials',
    }));
    const err = await client.getFeed('LogRecord', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeotabError);
    expect(err).toMatchObject({ type: 'InvalidUserException', method: 'Authenticate' });
    expect(calls).toHaveLength(1);
  });

  test('LoginResult.path: a host is called from then on; ThisServer and absent keep ours', async () => {
    expect([
      serverFromPath('ThisServer'),
      serverFromPath(null),
      serverFromPath('my3.geotab.com'),
    ]).toEqual([null, null, 'my3.geotab.com']);
    for (const [path, host] of [
      ['my3.geotab.com', 'my3.geotab.com'],
      ['ThisServer', 'my.geotab.com'],
      [null, 'my.geotab.com'],
    ] as const) {
      const { client, calls } = fake((c) =>
        c.method === 'Authenticate' ? login(path) : feed([], '01'),
      );
      await client.getFeed('LogRecord', null);
      expect(calls.map((c) => c.host)).toEqual(['my.geotab.com', host]);
    }
  });

  test('the stored server is unreachable: authenticate at the configured server, retry there', async () => {
    let first = true;
    const { client, calls } = fake((c) => {
      if (c.method === 'Authenticate') {
        const path = first ? 'my9.geotab.com' : 'ThisServer';
        first = false;
        return login(path);
      }
      return c.host === 'my9.geotab.com' ? 'network' : feed([], '02');
    });
    expect((await client.getFeed('LogRecord', null)).toVersion).toBe('02');
    expect(calls.map((c) => `${c.method}@${c.host}`)).toEqual([
      'Authenticate@my.geotab.com',
      'GetFeed@my9.geotab.com',
      'Authenticate@my.geotab.com',
      'GetFeed@my.geotab.com',
    ]);
    expect(decodeSession((client as unknown as { token: string }).token)?.server).toBeNull();
  });
});

describe('Geotab limits and errors', () => {
  test('Authenticate at most 10 a minute: the 11th never leaves the client', async () => {
    const { client, calls } = fake(() => login());
    for (let i = 0; i < 10; i++) await client.authenticate();
    const err = await client.authenticate().catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'OverLimitException', method: 'Authenticate' });
    expect((err as GeotabError).retryAfterSeconds).toBeGreaterThan(0);
    expect(calls).toHaveLength(10);
    wall += 61_000;
    await client.authenticate();
    expect(calls).toHaveLength(11);
  });

  test('GetFeed at most 60 a minute per entity type; another type has its own budget', async () => {
    const { client, calls } = fake(
      (c, n) =>
        c.method === 'Authenticate'
          ? login()
          : feed(
              Array.from({ length: 2 }, () => ({})),
              (0x100 + n).toString(16).padStart(16, '0'),
            ),
      { resultsLimit: 2, maxPages: 100 },
    );
    // Full pages ask for more: the poll pages until the minute's budget is spent.
    const r = await client.pollFaults('01');
    expect(r.hasMore).toBe(true);
    const feeds = () =>
      calls.filter((c) => c.method === 'GetFeed' && c.params.typeName === 'FaultData');
    expect(feeds()).toHaveLength(60);
    const err = await client.pollFaults(r.cursor).catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'OverLimitException', method: 'GetFeed' });
    expect(feeds()).toHaveLength(60);
    await client.pollPositions(null); // LogRecord: its own 60 (all full pages here too)
    expect(calls.filter((c) => c.params.typeName === 'LogRecord')).toHaveLength(60);
  });

  test("the server's OverLimitException (HTTP 200) carries its Retry-After", async () => {
    const { client } = fake((c) =>
      c.method === 'Authenticate'
        ? login()
        : {
            error: 'OverLimitException',
            message: 'API calls quota exceeded',
            headers: { 'retry-after': '58' },
          },
    );
    const err = await client.getFeed('LogRecord', null).catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'OverLimitException', retryAfterSeconds: 58 });
  });

  test('other types surface as GeotabError, switched on data.type (never the status)', async () => {
    const { client } = fake((c) =>
      c.method === 'Authenticate' ? login() : { error: 'DbUnavailableException', message: 'busy' },
    );
    const err = await client.getFeed('FaultData', null).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'GeotabError', type: 'DbUnavailableException' });
    expect(String((err as Error).message)).not.toContain('pw');
  });
});

describe('Geotab feeds', () => {
  const sd = (device: string, diagnostic: string, data: number) => ({
    dateTime: '2026-10-30T15:00:00.000Z',
    device: { id: device },
    diagnostic: { id: diagnostic },
    data,
  });

  test('StatusData: every diagnostic comes back; only ours, of mapped devices, land (with units)', async () => {
    const { client, calls } = fake(
      (c) => {
        if (c.method === 'Authenticate') return login();
        if (c.method === 'Get') {
          return {
            result: [
              { id: 'DiagnosticEngineHoursId', unitOfMeasure: { id: 'UnitOfMeasureSecondsId' } },
              { id: 'DiagnosticFuelLevelId', unitOfMeasure: { id: 'UnitOfMeasurePercentageId' } },
            ],
          };
        }
        return feed(
          [
            sd('b1', 'DiagnosticEngineHoursId', 3600),
            sd('b1', 'DiagnosticEngineSpeedId', 1250),
            sd('b1', 'DiagnosticFuelLevelId', 50),
            sd('b2', 'DiagnosticEngineHoursId', 7200), // a hauler's other truck
            { device: { id: 'b1' }, data: 1 }, // unreadable: dropped
          ],
          '0000000000000033',
        );
      },
      { only: new Set(['b1']) },
    );
    const r = await client.pollStats('0000000000000030');
    expect(r.cursor).toBe('0000000000000033');
    expect(r.items.map((i) => i.externalId)).toEqual([
      'b1:DiagnosticEngineHoursId:2026-10-30T15:00:00.000Z',
      'b1:DiagnosticFuelLevelId:2026-10-30T15:00:00.000Z',
    ]);
    expect(r.items[0]?.payload.diagnostic?.unitOfMeasure?.id).toBe('UnitOfMeasureSecondsId');
    const get = calls.find((c) => c.method === 'Get');
    expect(get?.params).toMatchObject({
      typeName: 'Diagnostic',
      search: { ids: [{ id: 'DiagnosticEngineHoursId' }, { id: 'DiagnosticFuelLevelId' }] },
    });
    // The lookup is cached: the next page asks for nothing.
    await client.pollStats(r.cursor);
    expect(calls.filter((c) => c.method === 'Get')).toHaveLength(1);
  });

  test('a null cursor is "from now": no fromVersion sent, the toVersion kept', async () => {
    const { client, calls } = fake((c) =>
      c.method === 'Authenticate' ? login() : feed([], '00000000000000ff'),
    );
    const r = await client.pollPositions(null);
    expect(r).toEqual({ items: [], cursor: '00000000000000ff', hasMore: false });
    expect(calls[1]?.params).not.toHaveProperty('fromVersion');
    await client.pollPositions(r.cursor);
    expect(calls[2]?.params.fromVersion).toBe('00000000000000ff');
  });

  test('limited scope: GetFeed LogRecord/StatusData refused → DeviceStatusInfo, said so', async () => {
    const log: string[] = [];
    const { client, calls } = fake(
      (c) => {
        if (c.method === 'Authenticate') return login();
        if (c.method === 'GetFeed') return { error: 'ArgumentException', message: 'limited scope' };
        return {
          result: [
            {
              device: { id: 'b1' },
              dateTime: '2026-10-30T14:59:30.000Z',
              latitude: 41.9,
              longitude: -84.0,
              bearing: 90,
              speed: 0,
              statusData: [sd('b1', 'DiagnosticEngineHoursId', 3600)],
            },
          ],
        };
      },
      { log: (m) => log.push(m) },
    );
    const p = await client.pollPositions('0000000000000001');
    expect(p.items.map((i) => i.payload.entity)).toEqual(['DeviceStatusInfo']);
    expect(client.fallbacks.has('positions')).toBe(true);
    expect(log.join('\n')).toMatch(/limited-scope/);
    // Remembered for an hour: no GetFeed probe on the next poll.
    const before = calls.filter((c) => c.method === 'GetFeed').length;
    const again = await client.pollPositions(p.cursor);
    expect(again.items).toEqual([]); // nothing newer
    expect(calls.filter((c) => c.method === 'GetFeed').length).toBe(before);
    const s = await client.pollStats(null);
    expect(s.items).toHaveLength(1);
    expect(calls.at(-1)?.params).toMatchObject({ typeName: 'Diagnostic' });
  });
});
