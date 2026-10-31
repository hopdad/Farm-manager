/**
 * CNH FieldOps OAuth 2 (authorization code with refresh tokens, at CNH's Auth0 identity server;
 * vendor-docs cnh.md §1.2, from develop.cnh.com "Tokens" / "Environment Variables" and the
 * FieldOps OpenAPI):
 *  - /authorize takes all SEVEN parameters: response_type=code, scope=offline_access, state,
 *    client_id, redirect_uri, audience and connection (the last two differ per environment:
 *    `cnhEndpoints`);
 *  - /oauth/token takes the secret IN THE FORM BODY (client_secret_post), and the refresh grant
 *    sends redirect_uri too (the spec marks it required);
 *  - /oauth/revoke takes JSON { client_id, client_secret, token }.
 * Tokens live in ingest.oauth_tokens through OAuthTokenStore, source `cnh`, one user-level grant:
 * org '' for a real account, SIM_GRANT_ORG for the stand-in's (so sim and sandbox/live never share
 * a row). In sim mode `cnhSimAutoConnect` drives the same flow against the stand-in's unattended
 * consent, so `pnpm dev` runs with no clicks.
 */
import { randomBytes } from 'node:crypto';
import type { CnhEndpoints } from '../endpoints';
import { type VendorHttpOptions, vendorFetch, vendorJson } from '../http';
import { type OAuthTokens, SIM_GRANT_ORG, type TokenStore } from '../oauth/token-store';
import { CNH_SCOPE, type CnhTokenResponse, cnhTokenResponseSchema } from './schemas';

export type CnhHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

/** Query flag of the stand-in's unattended consent (src/sim/vendors/cnh/routes.ts). */
export const CNH_SIM_AUTO_CONSENT_PARAM = 'sim_auto_consent';

/** Access tokens last 1 h in production and 6 h in staging (CNH's FAQ); assumed when absent. */
const DEFAULT_EXPIRES_IN = 3600;

export function newCnhState(): string {
  return randomBytes(16).toString('hex');
}

/** org_external_id of the CNH grant: SIM_GRANT_ORG against the stand-in, '' for a real account. */
export function cnhGrantOrg(ep: Pick<CnhEndpoints, 'environment'>): string {
  return ep.environment === 'sim' ? SIM_GRANT_ORG : '';
}

/** Where to send the browser to sign in at CNH and approve the app. */
export function cnhAuthorizeUrl(ep: CnhEndpoints, state: string): string {
  const u = new URL(ep.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', CNH_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('client_id', ep.clientId);
  u.searchParams.set('redirect_uri', ep.redirectUri);
  u.searchParams.set('audience', ep.audience);
  u.searchParams.set('connection', ep.connection);
  return u.toString();
}

export function cnhTokensFromResponse(r: CnhTokenResponse, now: Date): OAuthTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    tokenType: r.token_type ?? 'Bearer',
    expiresAt: new Date(now.getTime() + (r.expires_in ?? DEFAULT_EXPIRES_IN) * 1000),
    refreshExpiresAt: null,
    scopes: (r.scope ?? CNH_SCOPE).split(/\s+/).filter(Boolean),
  };
}

async function tokenRequest(
  ep: CnhEndpoints,
  form: Record<string, string>,
  http: CnhHttpOptions,
): Promise<OAuthTokens> {
  const now = (http.now ?? (() => new Date()))();
  const r = await vendorJson(
    cnhTokenResponseSchema,
    ep.tokenUrl,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      // client_secret_post: the client's credentials in the body, never an Authorization header.
      body: new URLSearchParams({
        client_id: ep.clientId,
        client_secret: ep.clientSecret,
        ...form,
      }).toString(),
    },
    // Never retry a grant: a code is single-use and a refresh token may rotate.
    { ...http, vendor: 'cnh', maxRetries: 0 },
  );
  return cnhTokensFromResponse(r, now);
}

/** authorization_code → tokens (the callback). */
export function exchangeCnhCode(
  ep: CnhEndpoints,
  code: string,
  http: CnhHttpOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(
    ep,
    { grant_type: 'authorization_code', redirect_uri: ep.redirectUri, code },
    http,
  );
}

/** refresh_token → new tokens; CNH's spec requires redirect_uri on the refresh grant too. */
export function refreshCnhTokens(
  ep: CnhEndpoints,
  refreshToken: string,
  http: CnhHttpOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(
    ep,
    { grant_type: 'refresh_token', redirect_uri: ep.redirectUri, refresh_token: refreshToken },
    http,
  );
}

/** Revoke a refresh token (JSON body, as the spec documents). */
export async function revokeCnhToken(
  ep: CnhEndpoints,
  token: string,
  http: CnhHttpOptions = {},
): Promise<void> {
  const res = await vendorFetch(
    ep.revokeUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: ep.clientId, client_secret: ep.clientSecret, token }),
    },
    { ...http, vendor: 'cnh', maxRetries: 0 },
  );
  await res.body?.cancel();
}

export class CnhConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CnhConnectError';
  }
}

/**
 * SIM ONLY: the authorization-code flow against the stand-in without a browser (its
 * `sim_auto_consent=1` answers the consent itself), the tokens stored, the access token returned.
 */
export async function cnhSimAutoConnect(
  ep: CnhEndpoints,
  store: TokenStore,
  http: CnhHttpOptions = {},
): Promise<string> {
  if (ep.environment !== 'sim') {
    throw new CnhConnectError('cnh: unattended consent exists only in sim mode');
  }
  const state = newCnhState();
  const url = new URL(cnhAuthorizeUrl(ep, state));
  url.searchParams.set(CNH_SIM_AUTO_CONSENT_PARAM, '1');
  const res = await vendorFetch(
    url.toString(),
    { method: 'GET', redirect: 'manual' },
    { ...http, vendor: 'cnh' },
  );
  const location = res.headers.get('location');
  await res.body?.cancel();
  if (!location) throw new CnhConnectError('cnh: sim consent did not redirect');
  const back = new URL(location);
  if (back.searchParams.get('state') !== state) {
    throw new CnhConnectError('cnh: sim consent returned the wrong state');
  }
  const code = back.searchParams.get('code');
  if (!code) {
    throw new CnhConnectError(
      `cnh: sim consent refused (${back.searchParams.get('error') ?? 'no code'})`,
    );
  }
  const tokens = await exchangeCnhCode(ep, code, http);
  await store.save(tokens);
  return tokens.accessToken;
}
