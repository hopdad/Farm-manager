/**
 * The Terminal client against a scripted fetch (no stand-in): `next` paging (never the count),
 * the 50-id chunks, both headers on data calls and only the key on /connections, one refused
 * connection skipped while the others sync (its watermarks kept), a bad item dropped and logged,
 * the connection cache, and the cursors' shape.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { TerminalEndpoint } from '../endpoints';
import {
  forgetTerminalConnections,
  parseMarkCursor,
  TERMINAL_MAX_IDS,
  TerminalClient,
} from './client';

const BASE = 'https://api.test/tsp/v1';
const endpoint: TerminalEndpoint = { baseUrl: BASE, secretKey: 'sk_test', connectionToken: null };
const NOW = Date.parse('2026-10-15T13:00:00Z');

interface Seen {
  path: string;
  query: Record<string, string>;
  auth: string | null;
  token: string | null;
}

function scripted(answer: (s: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const s: Seen = {
      path: url.pathname.replace('/tsp/v1', ''),
      query: Object.fromEntries(url.searchParams),
      auth: h.get('authorization'),
      token: h.get('connection-token'),
    };
    seen.push(s);
    const a = answer(s);
    return Response.json(a.body, { status: a.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const conn = (id: string, token: string, code = 'omnitracs-xrs') => ({
  id,
  token,
  provider: { code, name: code },
  status: 'connected',
});
const loc = (vehicle: string, t: string, modified: string, id = `vcl_loc_${t}`) => ({
  id,
  provider: 'omnitracs-xrs',
  vehicle,
  locatedAt: t,
  location: { longitude: -84, latitude: 42 },
  metadata: { modifiedAt: modified },
});

beforeEach(() => forgetTerminalConnections());

describe('TerminalClient', () => {
  test('follows `next` (as `cursor`) until it is absent, whatever the page sizes', async () => {
    const { fetch, seen } = scripted((s) => {
      if (s.path !== '/connections') throw new Error(s.path);
      if (!s.query.cursor) return { body: { results: [conn('conn_a', 'tkn_a')], next: 'p2' } };
      if (s.query.cursor === 'p2') return { body: { results: [], next: 'p3' } };
      return { body: { results: [conn('conn_b', 'tkn_b')] } };
    });
    const c = new TerminalClient(endpoint, { fetch, now: () => new Date(NOW) });
    expect((await c.connections()).map((x) => x.id)).toEqual(['conn_a', 'conn_b']);
    expect(seen.map((s) => [s.query.cursor ?? null, s.query.status])).toEqual([
      [null, 'connected'],
      ['p2', 'connected'],
      ['p3', 'connected'],
    ]);
    // The secret key alone lists connections.
    expect(seen.every((s) => s.auth === 'Bearer sk_test' && s.token === null)).toBe(true);
    // Cached: no second listing within the TTL.
    await c.connections();
    expect(seen).toHaveLength(3);
  });

  test('latest locations ask at most 50 vehicle ids a call, with both headers', async () => {
    const ids = Array.from(
      { length: TERMINAL_MAX_IDS + 7 },
      (_, i) => `vcl_${String(i).padStart(3, '0')}`,
    );
    const { fetch, seen } = scripted((s) => {
      if (s.path === '/connections') return { body: { results: [conn('conn_a', 'tkn_a')] } };
      if (s.path === '/vehicles/locations') {
        const want = s.query.vehicleIds?.split(',') ?? [];
        return {
          body: {
            results: want.map((v) => ({
              provider: 'omnitracs-xrs',
              vehicle: v,
              locatedAt: '2026-10-15T12:59:50Z',
              location: { longitude: -84, latitude: 42 },
            })),
          },
        };
      }
      return { body: { results: [] } };
    });
    const c = new TerminalClient(
      endpoint,
      { fetch, now: () => new Date(NOW) },
      {
        only: new Map([['conn_a', new Set(ids)]]),
      },
    );
    const r = await c.pollPositions(null);
    expect(r.items.filter((i) => i.payload.kind === 'latest')).toHaveLength(ids.length);
    const calls = seen.filter((s) => s.path === '/vehicles/locations');
    expect(calls.map((s) => s.query.vehicleIds?.split(',').length)).toEqual([50, 7]);
    expect(calls.every((s) => s.auth === 'Bearer sk_test' && s.token === 'tkn_a')).toBe(true);
    // History is asked per vehicle from the lookback window.
    const hist = seen.filter((s) => /^\/vehicles\/vcl_\d+\/locations$/.test(s.path));
    expect(hist).toHaveLength(ids.length);
    expect(hist[0]?.query.startAt).toBe('2026-10-14T13:00:00.000Z');
  });

  test('a refused connection is skipped and logged; the others sync; its watermarks stay put', async () => {
    let refuse = true;
    const { fetch } = scripted((s) => {
      if (s.path === '/connections') {
        return { body: { results: [conn('conn_a', 'tkn_a'), conn('conn_b', 'tkn_b')] } };
      }
      if (s.token === 'tkn_b' && refuse && s.path === '/vehicles/locations') {
        return { status: 422, body: { code: 'connection_disconnected', message: 'Disconnected' } };
      }
      if (/\/vehicles\/vcl_[ab]\/locations$/.test(s.path)) {
        const v = s.path.split('/')[2] as string;
        return { body: { results: [loc(v, '2026-10-15T12:59:40Z', '2026-10-15T12:59:50Z')] } };
      }
      if (s.path === '/vehicles/locations') return { body: { results: [] } };
      throw new Error(s.path);
    });
    const logs: string[] = [];
    const c = new TerminalClient(
      endpoint,
      { fetch, now: () => new Date(NOW) },
      {
        only: new Map([
          ['conn_a', new Set(['vcl_a'])],
          ['conn_b', new Set(['vcl_b'])],
        ]),
        log: (msg) => logs.push(msg),
      },
    );
    const first = await c.pollPositions(null);
    expect(first.items.map((i) => [i.payload.connectionId, i.payload.kind])).toEqual([
      ['conn_a', 'history'],
    ]);
    expect(logs.some((m) => m.includes('connection skipped'))).toBe(true);
    const marks = parseMarkCursor(first.cursor).marks;
    expect(Object.keys(marks)).toEqual(['conn_a|vcl_a']);
    // Back: conn_b's breadcrumb lands now (it was never marked as read).
    refuse = false;
    forgetTerminalConnections();
    const again = await c.pollPositions(first.cursor);
    expect(again.items.map((i) => i.payload.connectionId)).toEqual(['conn_b']);
  });

  test('every connection refused: the refusal throws (the stream shows failing)', async () => {
    const { fetch } = scripted((s) => {
      if (s.path === '/connections') return { body: { results: [conn('conn_a', 'tkn_a')] } };
      return { status: 410, body: { code: 'connection_deleted', message: 'Gone' } };
    });
    const c = new TerminalClient(endpoint, { fetch, now: () => new Date(NOW), maxRetries: 0 });
    await expect(c.pollFaults(null)).rejects.toMatchObject({ status: 410, detail: 'Gone' });
  });

  test('an unreadable item is dropped and logged with its id, never the page', async () => {
    const { fetch } = scripted((s) => {
      if (s.path === '/connections') return { body: { results: [conn('conn_a', 'tkn_a')] } };
      if (s.path === '/vehicles') {
        return {
          body: {
            results: [{ id: 'vcl_bad' }, { id: 'vcl_ok', provider: 'omnitracs-xrs', name: 'H3' }],
          },
        };
      }
      throw new Error(s.path);
    });
    const logs: { msg: string; data?: Record<string, unknown> }[] = [];
    const c = new TerminalClient(
      endpoint,
      { fetch, now: () => new Date(NOW) },
      {
        log: (msg, data) => logs.push({ msg, data }),
      },
    );
    const v = await c.vehicleList();
    expect(v.map((x) => x.vehicle.id)).toEqual(['vcl_ok']);
    expect(logs).toEqual([
      {
        msg: 'terminal: unreadable item dropped',
        data: { path: '/vehicles', id: 'vcl_bad' },
      },
    ]);
  });

  test('faults: the first run looks back one age-out window; then the newest modifiedAt is the cursor', async () => {
    const asked: string[] = [];
    const { fetch } = scripted((s) => {
      if (s.path === '/connections') return { body: { results: [conn('conn_a', 'tkn_a')] } };
      asked.push(s.query.modifiedAfter as string);
      return {
        body: {
          results: [
            {
              id: 'fc_evt_1',
              provider: 'omnitracs-xrs',
              vehicle: 'vcl_a',
              protocol: 'obdii',
              status: 'open',
              code: 'P0217',
              observedAt: '2026-10-15T12:58:00Z',
              metadata: { modifiedAt: '2026-10-15T12:58:30Z' },
            },
          ],
        },
      };
    });
    const c = new TerminalClient(
      endpoint,
      { fetch, now: () => new Date(NOW) },
      {
        only: new Map([['conn_a', new Set(['vcl_a'])]]),
      },
    );
    const first = await c.pollFaults(null);
    expect(first.items).toHaveLength(1);
    await c.pollFaults(first.cursor);
    expect(asked).toEqual(['2026-10-14T13:00:00.000Z', '2026-10-15T12:58:30Z']);
  });

  test('a cursor from another shape starts over', () => {
    expect(parseMarkCursor(null)).toEqual({ v: 1, marks: {}, latest: null });
    expect(parseMarkCursor('{"v":1,"seen":{}}')).toEqual({ v: 1, marks: {}, latest: null });
    expect(parseMarkCursor('not json')).toEqual({ v: 1, marks: {}, latest: null });
    expect(parseMarkCursor('{"v":1,"marks":{"a":"x","b":3},"latest":"{}"}')).toEqual({
      v: 1,
      marks: { a: 'x' },
      latest: '{}',
    });
  });
});
