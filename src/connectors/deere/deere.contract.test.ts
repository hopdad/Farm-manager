/**
 * Contract tests: the LIVE Deere client and OAuth helpers against the stand-in in-process
 * (random port, stub world, injectable wall clock), with an in-memory token store. The
 * database-backed store and its advisory lock are covered by oauth/token-store.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG } from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { createStubSimWorld } from '../../sim/vendors/stub-world';
import { type ConnectorConfig, type DeereEndpoints, deereEndpoints } from '../endpoints';
import { VendorHttpError } from '../http';
import { MemoryTokenStore } from '../oauth/memory-store';
import { OAuthReconnectError } from '../oauth/token-store';
import { DeereClient } from './client';
import { mapDeereBreadcrumb } from './mapper';
import { deereAuthorizeUrl, exchangeDeereCode, refreshDeereTokens, simAutoConnect } from './oauth';
import { deereBreadcrumbsSchema } from './schemas';

let wall = Date.parse('2026-10-29T13:00:00.000Z');
const now = () => new Date(wall);
const http = {
  now,
  sleep: async (ms: number) => {
    wall += ms;
  },
  timeoutMs: 2000,
};
let sim: VendorSim;
let ep: DeereEndpoints;

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0, now });
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3103' };
  ep = deereEndpoints('sim', cfg);
});
afterAll(() => sim.close());
beforeEach(() => {
  sim.control.reset({ scenario: 'harvest-day' });
  sim.counters.tokenGrants.authorization_code = 0;
  sim.counters.tokenGrants.refresh_token = 0;
});

function newClient(store = new MemoryTokenStore('deere', null, { now })) {
  return { store, client: new DeereClient({ endpoints: ep, tokens: store, http }) };
}

describe('Deere OAuth (sim)', () => {
  test('consent page, allow → code → tokens; a code works once', async () => {
    const url = deereAuthorizeUrl(ep, 'st-1');
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Sign in to Deere (simulated)</title>');

    const q = new URL(url).searchParams;
    const form = new URLSearchParams({
      response_type: 'code',
      client_id: q.get('client_id') ?? '',
      redirect_uri: q.get('redirect_uri') ?? '',
      scope: q.get('scope') ?? '',
      state: 'st-1',
      decision: 'allow',
    });
    const allow = await fetch(new URL(url).origin + new URL(url).pathname, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(allow.status).toBe(302);
    const back = new URL(allow.headers.get('location') ?? '');
    expect(back.origin + back.pathname).toBe('http://localhost:3103/api/oauth/deere');
    expect(back.searchParams.get('state')).toBe('st-1');
    const code = back.searchParams.get('code') ?? '';

    const tokens = await exchangeDeereCode(ep, code, http);
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresAt.getTime()).toBe(wall + 300_000);
    expect(tokens.scopes).toContain('offline_access');
    await expect(exchangeDeereCode(ep, code, http)).rejects.toMatchObject({
      status: 400,
      oauthError: 'invalid_grant',
    });

    const deny = await fetch(new URL(url).origin + new URL(url).pathname, {
      method: 'POST',
      body: new URLSearchParams({ ...Object.fromEntries(form), decision: 'deny' }),
      redirect: 'manual',
    });
    expect(new URL(deny.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
  });

  test('refresh tokens rotate: the old one is dead after use', async () => {
    const store = new MemoryTokenStore('deere', null, { now });
    await simAutoConnect(ep, store, http);
    const first = store.tokens?.refreshToken ?? '';
    const next = await refreshDeereTokens(ep, first, http);
    expect(next.refreshToken).not.toBe(first);
    await expect(refreshDeereTokens(ep, first, http)).rejects.toMatchObject({
      oauthError: 'invalid_grant',
    });
    expect(sim.counters.tokenGrants).toEqual({ authorization_code: 1, refresh_token: 1 });
  });

  test('bad client credentials are invalid_client', async () => {
    await expect(
      refreshDeereTokens({ ...ep, clientSecret: 'nope' }, 'x', http),
    ).rejects.toMatchObject({ status: 401, oauthError: 'invalid_client' });
    expect(SIM_CREDENTIALS.deere.clientId).toBe(ep.clientId);
  });
});

describe('Deere machine locations (sim)', () => {
  test('connects unattended, then returns breadcrumbs only for working machines', async () => {
    wall += 10 * 60_000; // ten sim minutes into the scenario: C1 is working, GC1 transports
    const { client, store } = newClient();
    const r = await client.pollLocations(null);
    expect(store.tokens).not.toBeNull();
    expect(sim.counters.tokenGrants.authorization_code).toBe(1);
    expect(r.items.length).toBe(60); // 10 min at 10 s
    expect(new Set(r.items.map((i) => i.payload.machineId))).toEqual(new Set(['stub-jd-c1']));
    const pos = r.items.flatMap((i) => mapDeereBreadcrumb(i.payload));
    expect(pos.every((p) => p.positionSource === 'deere_working')).toBe(true);
    expect(pos.every((p) => p.sourceOrg === SIM_DEERE_HOME_ORG)).toBe(true);
    expect(pos[0]?.speedMph).toBeCloseTo(5, 0);
    expect(r.cursor).toBe(new Date(wall).toISOString());
    expect(r.hasMore).toBe(false);
  });

  test('follows nextPage links across a long window', async () => {
    wall += 35 * 60_000;
    const { client } = newClient();
    const start = new Date(wall - 35 * 60_000);
    const crumbs = await client.breadcrumbs('stub-jd-c1', start, new Date(wall));
    expect(crumbs).toHaveLength(210); // pages of 100 + 100 + 10
    expect(new Set(crumbs.map((c) => c.eventTimestamp)).size).toBe(210);
    const raw = await fetch(
      `${ep.apiBase}/machines/stub-jd-c1/breadcrumbs?startDate=${start.toISOString()}`,
      { headers: { authorization: 'Bearer nope' } },
    );
    expect(raw.status).toBe(401);
    expect(deereBreadcrumbsSchema.safeParse({ links: [], values: crumbs }).success).toBe(true);
  });

  test('an expired access token is refreshed (rotating) and the call retried', async () => {
    wall += 10 * 60_000;
    const { client, store } = newClient();
    const first = await client.pollLocations(null);
    wall += 301_000; // past the 5-minute access token
    const second = await client.pollLocations(first.cursor);
    expect(second.items.length).toBeGreaterThan(0);
    expect(store.refreshes).toBe(1);
    expect(sim.counters.tokenGrants.refresh_token).toBe(1);
  });

  test('token_expired fault: 401 → one refresh → retry succeeds', async () => {
    wall += 10 * 60_000;
    const { client, store } = newClient();
    const first = await client.pollLocations(null);
    wall += 1000;
    sim.control.faults({ action: 'add', rule: { vendor: 'deere', kind: 'token_expired' } });
    wall += 10_000;
    const second = await client.pollLocations(first.cursor);
    expect(second.items.length).toBe(1);
    expect(store.refreshes).toBe(1);
    expect(sim.counters.faults.token_expired).toBe(1);
  });

  test('token_revoked fault: the step fails (re-consent needed); recovers once lifted', async () => {
    wall += 10 * 60_000;
    const { client } = newClient();
    const first = await client.pollLocations(null);
    sim.control.faults({
      action: 'add',
      rule: { id: 'rv', vendor: 'deere', kind: 'token_revoked' },
    });
    wall += 10_000;
    const err = await client.pollLocations(first.cursor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).status).toBe(401);
    sim.control.faults({ action: 'remove', id: 'rv' });
    wall += 10_000;
    const ok = await client.pollLocations(first.cursor);
    expect(ok.items.length).toBeGreaterThan(0);
  });

  test('sandbox/live never auto-connect: not connected means sign in at /api/oauth/deere', async () => {
    const store = new MemoryTokenStore('deere', null, { now });
    const live = new DeereClient({ endpoints: { ...ep, sim: false }, tokens: store, http });
    await expect(live.pollLocations(null)).rejects.toBeInstanceOf(OAuthReconnectError);
    await expect(simAutoConnect({ ...ep, sim: false }, store, http)).rejects.toThrow(/only in sim/);
  });
});
