/**
 * ingest.oauth_tokens through OAuthTokenStore against the stand-in's rotating token endpoint:
 * encrypted at rest, and exactly ONE refresh when 10 callers (separate store instances, as if
 * separate processes) find the token expired at the same time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { createStubSimWorld } from '../../sim/vendors/stub-world';
import { setupTestDb } from '../../test/db';
import { refreshDeereTokens, simAutoConnect } from '../deere/oauth';
import { type DeereEndpoints, deereEndpoints } from '../endpoints';
import { tokenKey } from './crypto';
import { OAuthReconnectError, OAuthTokenStore } from './token-store';

const t = setupTestDb(import.meta.url);
const key = tokenKey('ab'.repeat(32));
let sim: VendorSim;
let ep: DeereEndpoints;

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0 });
  ep = deereEndpoints('sim', { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3103' });
});
afterAll(() => sim.close());

const store = (now?: () => Date) =>
  new OAuthTokenStore({ pool: t().pool, source: 'deere', key, ...(now ? { now } : {}) });

describe('OAuthTokenStore', () => {
  test('stores the grant encrypted; reads it back', async () => {
    const access = await simAutoConnect(ep, store());
    const row = await t().pool.query(
      `select ciphertext, scopes, expires_at > now() as fresh from ingest.oauth_tokens
        where source = 'deere' and org_external_id = ''`,
    );
    expect(row.rows[0].fresh).toBe(true);
    expect(row.rows[0].scopes).toContain('offline_access');
    expect(row.rows[0].ciphertext).not.toContain(access);
    expect((await store().read())?.accessToken).toBe(access);
    expect(await store().accessToken(() => Promise.reject(new Error('no refresh needed')))).toBe(
      access,
    );
  });

  test('10 concurrent callers on an expired token: exactly one refresh, one new token', async () => {
    const before = sim.counters.tokenGrants.refresh_token;
    // Ten minutes from now the 5-minute token is expired for everyone.
    const later = () => new Date(Date.now() + 10 * 60_000);
    const refresher = (rt: string) => refreshDeereTokens(ep, rt, { now: later });
    const got = await Promise.all(
      Array.from({ length: 10 }, () => store(later).accessToken(refresher)),
    );
    expect(sim.counters.tokenGrants.refresh_token - before).toBe(1);
    expect(new Set(got).size).toBe(1);
    expect((await store().read())?.accessToken).toBe(got[0]);
  });

  test('after a 401, a caller holding a stale token reuses the refreshed one', async () => {
    const before = sim.counters.tokenGrants.refresh_token;
    const current = (await store().read())?.accessToken as string;
    const refresher = (rt: string) => refreshDeereTokens(ep, rt);
    expect(await store().refreshAfterReject('some-older-token', refresher)).toBe(current);
    expect(sim.counters.tokenGrants.refresh_token).toBe(before);
    const next = await store().refreshAfterReject(current, refresher);
    expect(next).not.toBe(current);
    expect(sim.counters.tokenGrants.refresh_token).toBe(before + 1);
  });

  test('a dead refresh token (stand-in reset) drops the row: re-consent needed', async () => {
    sim.control.reset({});
    const muchLater = () => new Date(Date.now() + 60 * 60_000);
    await expect(
      store(muchLater).accessToken((rt) => refreshDeereTokens(ep, rt)),
    ).rejects.toBeInstanceOf(OAuthReconnectError);
    expect(await store().read()).toBeNull();
  });

  test('ciphertext from another key does not decrypt', async () => {
    await simAutoConnect(ep, store());
    const other = new OAuthTokenStore({
      pool: t().pool,
      source: 'deere',
      key: tokenKey('cd'.repeat(32)),
    });
    await expect(other.read()).rejects.toThrow(/does not decrypt/);
  });
});
