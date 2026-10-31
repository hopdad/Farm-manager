import { describe, expect, test } from 'vitest';
import { CNH_ENVIRONMENTS, type CnhEndpoints } from '../endpoints';
import { SIM_GRANT_ORG } from '../oauth/token-store';
import {
  cnhAuthorizeUrl,
  cnhGrantOrg,
  exchangeCnhCode,
  refreshCnhTokens,
  revokeCnhToken,
} from './oauth';

const staging: CnhEndpoints = {
  apiBase: CNH_ENVIRONMENTS.staging.apiBase,
  authBase: CNH_ENVIRONMENTS.staging.authBase,
  authorizeUrl: `${CNH_ENVIRONMENTS.staging.authBase}/authorize`,
  tokenUrl: `${CNH_ENVIRONMENTS.staging.authBase}/oauth/token`,
  revokeUrl: `${CNH_ENVIRONMENTS.staging.authBase}/oauth/revoke`,
  audience: CNH_ENVIRONMENTS.staging.audience,
  connection: CNH_ENVIRONMENTS.staging.connection,
  clientId: 'cid',
  clientSecret: 'secret',
  subscriptionKey: 'key',
  redirectUri: 'https://farm.example/api/oauth/cnh',
  environment: 'staging',
};

function recorder(reply: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const now = new Date('2026-10-30T12:00:00.000Z');

describe('CNH FieldOps OAuth', () => {
  test('authorize: all seven parameters, audience and connection of the environment', () => {
    const u = new URL(cnhAuthorizeUrl(staging, 'st8'));
    expect(`${u.origin}${u.pathname}`).toBe('https://stg.identity.cnhind.com/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      scope: 'offline_access',
      state: 'st8',
      client_id: 'cid',
      redirect_uri: 'https://farm.example/api/oauth/cnh',
      audience: 'https://sandbox.api-data.cnh.com/',
      connection: 'STG-ADFS-CONN',
    });
  });

  test('code exchange: client_secret_post (the secret in the form body, no Basic header)', async () => {
    const r = recorder(() =>
      Response.json({
        access_token: 'a1',
        refresh_token: 'r1',
        expires_in: 21600,
        token_type: 'Bearer',
      }),
    );
    const tokens = await exchangeCnhCode(staging, 'the-code', { fetch: r.fetch, now: () => now });
    const req = r.seen[0];
    expect(req?.url).toBe('https://stg.identity.cnhind.com/oauth/token');
    expect(new Headers(req?.init.headers).get('authorization')).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(String(req?.init.body)))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      grant_type: 'authorization_code',
      redirect_uri: 'https://farm.example/api/oauth/cnh',
      code: 'the-code',
    });
    expect(tokens).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenType: 'Bearer',
      expiresAt: new Date('2026-10-30T18:00:00.000Z'),
      refreshExpiresAt: null,
      scopes: ['offline_access'],
    });
  });

  test('refresh sends redirect_uri too; an Auth0 body without expires_in assumes an hour', async () => {
    const r = recorder(() => Response.json({ access_token: 'a2' }));
    const tokens = await refreshCnhTokens(staging, 'r1', { fetch: r.fetch, now: () => now });
    expect(Object.fromEntries(new URLSearchParams(String(r.seen[0]?.init.body)))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      grant_type: 'refresh_token',
      redirect_uri: 'https://farm.example/api/oauth/cnh',
      refresh_token: 'r1',
    });
    expect(tokens.refreshToken).toBeNull(); // the store keeps the one it has
    expect(tokens.expiresAt.toISOString()).toBe('2026-10-30T13:00:00.000Z');
  });

  test('an invalid_grant answer is an OAuth error the token store recognises', async () => {
    const r = recorder(
      () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'nope' }), {
          status: 403,
        }),
    );
    await expect(refreshCnhTokens(staging, 'r1', { fetch: r.fetch })).rejects.toMatchObject({
      oauthError: 'invalid_grant',
    });
    expect(r.seen).toHaveLength(1); // never retried
  });

  test('revoke posts JSON { client_id, client_secret, token }', async () => {
    const r = recorder(() => Response.json({}));
    await revokeCnhToken(staging, 'r9', { fetch: r.fetch });
    expect(r.seen[0]?.url).toBe('https://stg.identity.cnhind.com/oauth/revoke');
    expect(new Headers(r.seen[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(r.seen[0]?.init.body))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      token: 'r9',
    });
  });

  test('the grant row: SIM_GRANT_ORG against the stand-in, "" for a real account', () => {
    expect(cnhGrantOrg({ environment: 'sim' })).toBe(SIM_GRANT_ORG);
    expect(cnhGrantOrg({ environment: 'staging' })).toBe('');
    expect(cnhGrantOrg({ environment: 'production' })).toBe('');
  });
});
