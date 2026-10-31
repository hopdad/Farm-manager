/**
 * The generic AEMP client against a test server (a fetch handler): every auth style (bearer +
 * subscription key together, basic, oauth2 with both grants, deere_oauth on the Deere token
 * store, subscription_key alone), Accept from the format, paging rebuilt from our own base URL,
 * per-provider pacing, the snapshot diff, and the fault series with its windows.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { AempEndpoint } from '../endpoints';
import { aempAccept } from '../endpoints';
import { MemoryTokenStore } from '../oauth/memory-store';
import type { OAuthTokens } from '../oauth/token-store';
import { clearAempTokenCache } from './auth';
import {
  AEMP_FAULT_LOOKBACK_MS,
  AempClient,
  parseAempFaultsCursor,
  parseAempFleetCursor,
} from './client';
import { ISO_FAULTS_XML, ISO_XML, SAMSARA_JSON } from './fixtures/spec-examples';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

function server(handler: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    seen.push(req);
    return handler(req);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const xmlReply = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } });

let wall = Date.parse('2026-10-30T14:10:00.000Z');
const http = (fetch: typeof globalThis.fetch) => ({
  fetch,
  now: () => new Date(wall),
  sleep: async () => {},
  maxRetries: 0,
});

const ep = (over: Partial<AempEndpoint> = {}): AempEndpoint => ({
  id: 'kubota',
  baseUrl: 'https://dealer.example/aemp',
  auth: 'bearer',
  token: 'tok',
  format: 'auto',
  accept: aempAccept('auto'),
  minIntervalSeconds: 900,
  ...over,
});

beforeEach(() => {
  clearAempTokenCache();
  wall = Date.parse('2026-10-30T14:10:00.000Z');
});

describe('auth styles', () => {
  test('bearer + subscription key together; Accept from the format', async () => {
    const s = server(() => xmlReply(ISO_XML.replace(/<Links><rel>next.*?<\/Links>/s, '')));
    const c = new AempClient({
      endpoints: [],
      http: http(s.fetch),
    });
    await c.fleetPage(ep({ subscriptionKey: 'apim-key' }), 1);
    expect(s.seen[0]?.headers).toMatchObject({
      authorization: 'Bearer tok',
      'ocp-apim-subscription-key': 'apim-key',
      accept: 'application/xml, application/json;q=0.9',
    });
    await c
      .fleetPage(
        ep({
          auth: 'subscription_key',
          token: undefined,
          subscriptionKey: 'k2',
          subscriptionKeyHeader: 'X-Api-Key',
          format: 'json',
          accept: aempAccept('json'),
        }),
        1,
      )
      .catch(() => {});
    expect(s.seen[1]?.headers).toMatchObject({ 'x-api-key': 'k2', accept: 'application/json' });
    expect(s.seen[1]?.headers.authorization).toBeUndefined();
  });

  test('basic: username and password', async () => {
    const s = server(() => xmlReply(ISO_XML));
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    await c.fleetPage(ep({ auth: 'basic', username: 'fleet-42', password: 'p@ss' }), 1);
    expect(s.seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('fleet-42:p@ss').toString('base64')}`,
    );
  });

  test('oauth2 client_credentials: secret in the form body, token cached, a 401 renews once', async () => {
    let issued = 0;
    let rejectNext = false;
    const s = server((req) => {
      if (req.url.pathname === '/token') {
        issued++;
        return Response.json({ access_token: `t${issued}`, expires_in: 1200 });
      }
      if (rejectNext) {
        rejectNext = false;
        return new Response('{"message":"expired"}', { status: 401 });
      }
      return xmlReply(ISO_XML);
    });
    const e = ep({
      id: 'trackunit',
      auth: 'oauth2',
      token: undefined,
      clientId: 'cid',
      clientSecret: 'secret',
      tokenUrl: 'https://auth.example/token',
      scope: 'aemp',
    });
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    await c.fleetPage(e, 1);
    await c.fleetPage(e, 1);
    expect(issued).toBe(1);
    const tokenReq = s.seen[0] as Seen;
    expect(tokenReq.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(tokenReq.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'secret',
      scope: 'aemp',
    });
    expect(tokenReq.headers.authorization).toBeUndefined();
    expect(s.seen[1]?.headers.authorization).toBe('Bearer t1');
    rejectNext = true;
    await c.fleetPage(e, 1);
    expect(issued).toBe(2);
    expect(s.seen.at(-1)?.headers.authorization).toBe('Bearer t2');
    // Near expiry: a new token.
    wall += 1200_000;
    await c.fleetPage(e, 1);
    expect(issued).toBe(3);
  });

  test('oauth2 password grant: HTTP Basic client auth, username and password in the body', async () => {
    const s = server((req) =>
      req.url.pathname === '/token'
        ? Response.json({ access_token: 'pw-token' })
        : xmlReply(ISO_XML),
    );
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    await c.fleetPage(
      ep({
        auth: 'oauth2',
        grantType: 'password',
        clientId: 'cid',
        clientSecret: 'cs',
        username: 'api-user',
        password: 'api-pass',
        tokenUrl: 'https://auth.example/token',
      }),
      1,
    );
    const t = s.seen[0] as Seen;
    expect(t.headers.authorization).toBe(`Basic ${Buffer.from('cid:cs').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(t.body))).toEqual({
      grant_type: 'password',
      username: 'api-user',
      password: 'api-pass',
    });
    expect(s.seen[1]?.headers.authorization).toBe('Bearer pw-token');
  });

  test("deere_oauth: the Deere connection's token, refreshed through its store after a 401", async () => {
    const tokens: OAuthTokens = {
      accessToken: 'jd-old',
      refreshToken: 'jd-refresh',
      tokenType: 'Bearer',
      expiresAt: new Date(wall + 3_600_000),
      refreshExpiresAt: null,
      scopes: ['eq1', 'offline_access'],
    };
    const store = new MemoryTokenStore('deere', tokens, { now: () => new Date(wall) });
    let refreshed = 0;
    const refresher = async () => {
      refreshed++;
      return { ...tokens, accessToken: 'jd-new', refreshToken: 'jd-refresh-2' };
    };
    const s = server((req) =>
      req.headers.authorization === 'Bearer jd-old'
        ? new Response('No Authorization Header Found', { status: 401 })
        : xmlReply(ISO_XML),
    );
    const c = new AempClient({ endpoints: [], http: http(s.fetch), deere: { store, refresher } });
    const page = await c.fleetPage(
      ep({
        id: 'deere',
        auth: 'deere_oauth',
        token: undefined,
        format: 'xml',
        accept: aempAccept('xml'),
      }),
      1,
    );
    expect(page.machines).toHaveLength(2);
    expect(refreshed).toBe(1);
    expect(s.seen.map((r) => r.headers.authorization)).toEqual(['Bearer jd-old', 'Bearer jd-new']);
    // No Deere grant: a clear message, no request.
    const none = new AempClient({ endpoints: [], http: http(s.fetch) });
    await expect(none.fleetPage(ep({ id: 'deere', auth: 'deere_oauth' }), 1)).rejects.toThrow(
      /needs the Deere connection/,
    );
    const empty = new AempClient({
      endpoints: [],
      http: http(s.fetch),
      deere: { store: new MemoryTokenStore('deere'), refresher },
    });
    await expect(empty.fleetPage(ep({ id: 'deere', auth: 'deere_oauth' }), 1)).rejects.toThrow(
      /sign in at \/api\/oauth\/deere/,
    );
  });

  test('a 401 that cannot be renewed stands (bearer)', async () => {
    const s = server(() => new Response('{"message":"invalid token"}', { status: 401 }));
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    await expect(c.fleetPage(ep(), 1)).rejects.toThrow(/HTTP 401 \(invalid token\)/);
    expect(s.seen).toHaveLength(1);
  });
});

describe('snapshot paging, pacing and the diff', () => {
  /** Three pages; hrefs on a foreign host, as Deere's and Samsara's examples have them. */
  const pages = (n: number, total = 3) => {
    const next =
      n < total
        ? `<Links><rel>next</rel><href>https://elsewhere.example/aemp/Fleet/${n + 1}</href></Links>`
        : '';
    return `<Fleet version="1" snapshotTime="2026-10-30T14:05:00Z"><Links><rel>self</rel><href>https://elsewhere.example/aemp/Fleet/${n}</href></Links>${next}
      <Equipment><EquipmentHeader><PIN>P${n}</PIN></EquipmentHeader>
      <Location datetime="2026-10-30T14:0${n}:00Z"><Latitude>41.${n}</Latitude><Longitude>-84.${n}</Longitude></Location>
      <CumulativeOperatingHours datetime="2026-10-30T13:45:00Z"><Hour>${100 + n}</Hour></CumulativeOperatingHours></Equipment></Fleet>`;
  };

  test('follows next to the last page, rebuilding each URL from our base (never the href host)', async () => {
    const s = server((req) => xmlReply(pages(Number(req.url.pathname.split('/').at(-1)))));
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    const snap = await c.fleetSnapshot(ep());
    expect(snap.pages).toBe(3);
    expect(snap.machines.map((m) => m.id)).toEqual(['P1', 'P2', 'P3']);
    expect(s.seen.map((r) => r.url.toString())).toEqual([
      'https://dealer.example/aemp/Fleet/1',
      'https://dealer.example/aemp/Fleet/2',
      'https://dealer.example/aemp/Fleet/3',
    ]);
  });

  test('a next link that does not move on stops the loop', async () => {
    const s = server(() =>
      xmlReply(
        '<Fleet><Links><rel>next</rel><href>https://x/Fleet/1</href></Links><Equipment><EquipmentHeader><PIN>A</PIN></EquipmentHeader></Equipment></Fleet>',
      ),
    );
    const c = new AempClient({ endpoints: [], http: http(s.fetch) });
    expect((await c.fleetSnapshot(ep())).pages).toBe(1);
  });

  test('each provider at most every minIntervalSeconds; only moved sections are emitted', async () => {
    let locMinute = 1;
    const s = server((req) => {
      if (req.url.host === 'samsara.example') {
        return Response.json(SAMSARA_JSON);
      }
      return xmlReply(
        `<Fleet snapshotTime="2026-10-30T14:05:00Z"><Links><rel>self</rel><href>x</href></Links>
         <Equipment><EquipmentHeader><PIN>P1</PIN></EquipmentHeader>
         <Location datetime="2026-10-30T14:0${locMinute}:00Z"><Latitude>41</Latitude><Longitude>-84</Longitude></Location>
         <CumulativeOperatingHours datetime="2026-10-30T13:45:00Z"><Hour>101</Hour></CumulativeOperatingHours></Equipment></Fleet>`,
      );
    });
    const kubota = ep();
    const samsara = ep({
      id: 'samsara',
      baseUrl: 'https://samsara.example/beta/aemp',
      format: 'json',
      accept: aempAccept('json'),
      idElement: 'EquipmentID',
      minIntervalSeconds: 3600,
    });
    const c = new AempClient({ endpoints: [kubota, samsara], http: http(s.fetch) });
    const first = await c.pollFleet(null);
    expect(first.items.map((i) => i.payload.machineId).sort()).toEqual(['494123', 'P1']);
    expect(
      Object.keys(
        first.items.find((i) => i.payload.machineId === 'P1')?.payload.equipment ?? {},
      ).sort(),
    ).toEqual(['CumulativeOperatingHours', 'EquipmentHeader', 'Location']);
    expect(s.seen).toHaveLength(2);

    // 10 minutes later: nobody is due (900 s / 3600 s).
    wall += 600_000;
    const early = await c.pollFleet(first.cursor);
    expect(early.items).toEqual([]);
    expect(s.seen).toHaveLength(2);
    expect(early.cursor).toBe(first.cursor);

    // 15 minutes after the first poll (minus the scheduler's slack): kubota only; only the
    // Location moved, so only it is emitted.
    wall += 295_000;
    locMinute = 6;
    const later = await c.pollFleet(first.cursor);
    expect(s.seen).toHaveLength(3);
    expect(later.items).toHaveLength(1);
    expect(later.items[0]?.payload.equipment).toEqual({
      EquipmentHeader: { PIN: 'P1' },
      Location: { datetime: '2026-10-30T14:06:00.000Z', Latitude: 41, Longitude: -84 },
    });
    expect(later.items[0]?.externalId).toBe('kubota:P1@2026-10-30T14:06:00.000Z');
    const cur = parseAempFleetCursor(later.cursor);
    expect(cur.providers.kubota?.polledAt).toBe(new Date(wall).toISOString());
    expect(cur.providers.samsara?.polledAt).toBe('2026-10-30T14:10:00.000Z');
  });

  test('one failing provider is reported, the others still land; all failing fails the poll', async () => {
    const s = server((req) =>
      req.url.host === 'down.example'
        ? new Response('{"message":"nope"}', { status: 403 })
        : xmlReply(ISO_XML),
    );
    const down = ep({ id: 'down', baseUrl: 'https://down.example' });
    const c = new AempClient({ endpoints: [ep(), down], http: http(s.fetch) });
    const r = await c.pollFleet(null);
    expect(r.items.map((i) => i.payload.provider)).toEqual(['kubota', 'kubota']);
    expect(r.failed).toEqual([{ provider: 'down', error: 'aemp /Fleet/1: HTTP 403 (nope)' }]);
    const cur = parseAempFleetCursor(r.cursor);
    expect(cur.providers.down?.error).toMatch(/403/);
    expect(cur.providers.down?.polledAt).toBeUndefined(); // retried next run
    const onlyDown = new AempClient({ endpoints: [down], http: http(s.fetch) });
    await expect(onlyDown.pollFleet(null)).rejects.toThrow(/HTTP 403/);
  });

  test("Deere's connections link becomes a note in the cursor", async () => {
    const s = server(() =>
      xmlReply(
        '<Fleet><Links><rel>connections</rel><href>https://connections.deere.com/connections/app/select-organizations</href></Links></Fleet>',
      ),
    );
    const c = new AempClient({ endpoints: [ep({ id: 'deere' })], http: http(s.fetch) });
    const r = await c.pollFleet(null);
    expect(parseAempFleetCursor(r.cursor).providers.deere?.note).toMatch(
      /approve it at https:\/\/connections\.deere\.com/,
    );
  });
});

describe('the fault series', () => {
  const faultsEp = ep({ faultsPath: '/Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}' });

  test('per machine over (last end, now], id encoded once, occurrences as raw items', async () => {
    const s = server((req) =>
      req.url.pathname.includes('NO%2FFAULTS')
        ? new Response('', { status: 404 })
        : xmlReply(ISO_FAULTS_XML),
    );
    const c = new AempClient({ endpoints: [faultsEp, ep({ id: 'samsara' })], http: http(s.fetch) });
    const r = await c.pollFaults(null, { kubota: ['KBT0042', 'NO/FAULTS'] });
    const start = new Date(wall - AEMP_FAULT_LOOKBACK_MS).toISOString().replace('.000Z', 'Z');
    expect(s.seen.map((x) => x.url.pathname)).toEqual([
      `/aemp/Fleet/Equipment/ID/KBT0042/Faults/${start}/2026-10-30T14:10:00Z/1`,
      `/aemp/Fleet/Equipment/ID/NO%2FFAULTS/Faults/${start}/2026-10-30T14:10:00Z/1`,
    ]);
    expect(r.items.map((i) => i.externalId)).toEqual([
      'kubota:KBT0042:2026-10-30T09:12:00.000Z:SPN 110 FMI 0',
      'kubota:KBT0042:2026-10-30T10:30:00.000Z:E9031',
    ]);
    const cur = parseAempFaultsCursor(r.cursor);
    expect(cur.providers.kubota?.machines).toEqual({
      KBT0042: '2026-10-30T14:10:00.000Z',
      'NO/FAULTS': '2026-10-30T14:10:00.000Z',
    });
    expect(cur.providers.samsara).toBeUndefined(); // no fault series

    wall += 900_000;
    await c.pollFaults(r.cursor, { kubota: ['KBT0042'] });
    expect(s.seen.at(-1)?.url.pathname).toBe(
      '/aemp/Fleet/Equipment/ID/KBT0042/Faults/2026-10-30T14:10:00Z/2026-10-30T14:25:00Z/1',
    );
  });
});
