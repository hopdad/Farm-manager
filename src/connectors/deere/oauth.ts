/**
 * Deere OAuth 2 (authorization-code grant with refresh tokens). Used by:
 *  - /api/oauth/deere (the browser flow: consent page → callback → exchangeCode → store),
 *  - the Deere client (refresh under the advisory lock, ../oauth/token-store.ts),
 *  - `simAutoConnect` (sim mode only): the same flow driven by code against the stand-in's
 *    unattended consent, so `pnpm dev` gets Deere tokens with no clicks.
 */
import { randomBytes } from 'node:crypto';
import type { DeereEndpoints } from '../endpoints';
import { type VendorHttpOptions, vendorFetch, vendorJson } from '../http';
import type { OAuthTokens, TokenStore } from '../oauth/token-store';
import { DEERE_SCOPES, type DeereTokenResponse, deereTokenResponseSchema } from './schemas';

export type DeereHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

/** Query flag of the stand-in's unattended consent (src/sim/vendors/deere/routes.ts). */
const SIM_AUTO_CONSENT_PARAM = 'sim_auto_consent';

export function newOAuthState(): string {
  return randomBytes(16).toString('hex');
}

/** Where to send the browser to sign in and approve the app. */
export function deereAuthorizeUrl(ep: DeereEndpoints, state: string): string {
  const u = new URL(`${ep.authBase}/v1/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', ep.clientId);
  u.searchParams.set('redirect_uri', ep.redirectUri);
  u.searchParams.set('scope', DEERE_SCOPES.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

export function tokensFromResponse(r: DeereTokenResponse, now: Date): OAuthTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    tokenType: r.token_type,
    expiresAt: new Date(now.getTime() + r.expires_in * 1000),
    refreshExpiresAt: null, // not in the token response
    scopes: (r.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

function basicAuth(ep: DeereEndpoints): string {
  const id = encodeURIComponent(ep.clientId);
  const secret = encodeURIComponent(ep.clientSecret);
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

async function tokenRequest(
  ep: DeereEndpoints,
  form: Record<string, string>,
  http: DeereHttpOptions,
): Promise<OAuthTokens> {
  const now = (http.now ?? (() => new Date()))();
  const r = await vendorJson(
    deereTokenResponseSchema,
    `${ep.authBase}/v1/token`,
    {
      method: 'POST',
      headers: {
        authorization: basicAuth(ep),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    },
    // Never retry a grant: a code is single-use and a refresh token rotates.
    { ...http, vendor: 'deere', maxRetries: 0 },
  );
  return tokensFromResponse(r, now);
}

/** authorization_code → tokens (the callback). */
export function exchangeDeereCode(
  ep: DeereEndpoints,
  code: string,
  http: DeereHttpOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(
    ep,
    { grant_type: 'authorization_code', code, redirect_uri: ep.redirectUri },
    http,
  );
}

/** refresh_token → new tokens (rotating: the old refresh token is dead afterwards). */
export function refreshDeereTokens(
  ep: DeereEndpoints,
  refreshToken: string,
  http: DeereHttpOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(ep, { grant_type: 'refresh_token', refresh_token: refreshToken }, http);
}

export class DeereConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeereConnectError';
  }
}

/**
 * SIM ONLY: run the authorization-code flow against the stand-in without a browser (its
 * `sim_auto_consent=1` answers the consent itself), store the tokens, return the access token.
 */
export async function simAutoConnect(
  ep: DeereEndpoints,
  store: TokenStore,
  http: DeereHttpOptions = {},
): Promise<string> {
  if (!ep.sim) throw new DeereConnectError('deere: unattended consent exists only in sim mode');
  const state = newOAuthState();
  const url = new URL(deereAuthorizeUrl(ep, state));
  url.searchParams.set(SIM_AUTO_CONSENT_PARAM, '1');
  const res = await vendorFetch(
    url.toString(),
    { method: 'GET', redirect: 'manual' },
    { ...http, vendor: 'deere' },
  );
  const location = res.headers.get('location');
  await res.body?.cancel();
  if (!location) throw new DeereConnectError('deere: sim consent did not redirect');
  const back = new URL(location);
  if (back.searchParams.get('state') !== state) {
    throw new DeereConnectError('deere: sim consent returned the wrong state');
  }
  const code = back.searchParams.get('code');
  if (!code) {
    throw new DeereConnectError(
      `deere: sim consent refused (${back.searchParams.get('error') ?? 'no code'})`,
    );
  }
  const tokens = await exchangeDeereCode(ep, code, http);
  await store.save(tokens);
  return tokens.accessToken;
}
