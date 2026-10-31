/**
 * How the generic AEMP client authenticates to each provider (AEMP_PROVIDERS[].auth, src/config.ts;
 * checked against each provider's docs, vendor-docs aemp.md §2):
 *
 *   none              nothing (a test server)
 *   bearer            `Authorization: Bearer <token>` (Samsara's API token, Read AEMP scope)
 *   basic             `Authorization: Basic base64(username:password)` (a dealer's ISO
 *                     credentials, e.g. Kubota: Fleet ID, username, password; scheme unconfirmed)
 *   oauth2            a token from `tokenUrl`, cached until it nears expiry:
 *                       client_credentials (Trackunit Iris v2): client_id + client_secret in the
 *                         form body (developers.trackunit.com …/access-token-v2)
 *                       password (Trackunit v1): HTTP Basic client auth + username/password
 *                         (developers.trackunit.com …/access-token)
 *   deere_oauth       the Deere connection's own user grant (scopes `eq1 offline_access`) from the
 *                     Deere token store, refreshed under its advisory lock (Deere's ISO 15143-3
 *                     API at partneraemp.deere.com / sandboxaemp.deere.com)
 *   subscription_key  only the API-management key header
 * A `subscriptionKey` rides along with ANY style (`subscriptionKeyHeader`, default
 * Ocp-Apim-Subscription-Key: CNH's APIM gateway wants the bearer token and the key together).
 *
 * A 401 is retried once when the style can get a new credential (oauth2: a fresh token;
 * deere_oauth: the store's refresh-after-reject). Credentials never appear in errors or logs.
 */
import { z } from 'zod';
import type { AempEndpoint } from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import { OAuthReconnectError, type TokenRefresher, type TokenStore } from '../oauth/token-store';

export type AempHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

export const DEFAULT_SUBSCRIPTION_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

/** The Deere connection's token store and refresher (auth `deere_oauth`). */
export interface DeereGrant {
  store: TokenStore;
  refresher: TokenRefresher;
}

/** A provider asks for the Deere grant but none is connected (sign in on /api/oauth/deere). */
export class AempAuthError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(`aemp provider '${provider}': ${message}`);
    this.name = 'AempAuthError';
    this.provider = provider;
  }
}

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/)]).optional(),
});

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** oauth2 tokens per provider and client, in memory (Trackunit v2 tokens live 20 min, no refresh). */
const tokenCache = new Map<string, CachedToken>();

/** Forget every cached oauth2 token (tests). */
export function clearAempTokenCache(): void {
  tokenCache.clear();
}

const cacheKey = (ep: AempEndpoint) =>
  [ep.id, ep.tokenUrl, ep.clientId, ep.grantType ?? 'client_credentials', ep.scope ?? ''].join('|');

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

/** Refresh a minute before expiry. */
const SKEW_MS = 60_000;

export class AempAuth {
  private readonly http: AempHttpOptions;
  private readonly deere: DeereGrant | null;

  constructor(opts: { http?: AempHttpOptions; deere?: DeereGrant | null } = {}) {
    this.http = opts.http ?? {};
    this.deere = opts.deere ?? null;
  }

  private now(): number {
    return (this.http.now ?? (() => new Date()))().getTime();
  }

  private async oauth2Token(ep: AempEndpoint, fresh: boolean): Promise<string> {
    const key = cacheKey(ep);
    const hit = tokenCache.get(key);
    if (!fresh && hit && hit.expiresAt - SKEW_MS > this.now()) return hit.token;
    const password = ep.grantType === 'password';
    const form = new URLSearchParams({ grant_type: password ? 'password' : 'client_credentials' });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (password) {
      // Trackunit v1: client auth by HTTP Basic, the user's credentials in the body.
      headers.authorization = basic(ep.clientId ?? '', ep.clientSecret ?? '');
      form.set('username', ep.username ?? '');
      form.set('password', ep.password ?? '');
    } else {
      form.set('client_id', ep.clientId ?? '');
      form.set('client_secret', ep.clientSecret ?? '');
    }
    if (ep.scope) form.set('scope', ep.scope);
    const r = await vendorJson(
      tokenResponseSchema,
      ep.tokenUrl ?? '',
      { method: 'POST', headers, body: form.toString() },
      // A token request is never retried blindly (a password grant may lock an account).
      { ...this.http, vendor: 'aemp', maxRetries: 0 },
    );
    const ttl = r.expires_in === undefined ? 3600 : Number(r.expires_in);
    const token = { token: r.access_token, expiresAt: this.now() + ttl * 1000 };
    tokenCache.set(key, token);
    return token.token;
  }

  private async deereToken(ep: AempEndpoint): Promise<string> {
    if (!this.deere) {
      throw new AempAuthError(ep.id, 'auth deere_oauth needs the Deere connection (none given)');
    }
    const token = await this.deere.store.accessToken(this.deere.refresher);
    if (!token) {
      throw new AempAuthError(
        ep.id,
        'the Deere connection is not signed in (sign in at /api/oauth/deere; the grant needs eq1 offline_access)',
      );
    }
    return token;
  }

  /** The headers that authenticate one request to `ep`. */
  async headers(ep: AempEndpoint): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    switch (ep.auth) {
      case 'none':
      case 'subscription_key':
        break;
      case 'bearer':
        h.authorization = `Bearer ${ep.token ?? ''}`;
        break;
      case 'basic':
        h.authorization = basic(ep.username ?? '', ep.password ?? '');
        break;
      case 'oauth2':
        h.authorization = `Bearer ${await this.oauth2Token(ep, false)}`;
        break;
      case 'deere_oauth':
        h.authorization = `Bearer ${await this.deereToken(ep)}`;
        break;
    }
    if (ep.subscriptionKey) {
      h[ep.subscriptionKeyHeader ?? DEFAULT_SUBSCRIPTION_KEY_HEADER] = ep.subscriptionKey;
    }
    return h;
  }

  /**
   * The provider answered 401 to `sent`: get a new credential when the style can. True = retry
   * once with `headers(ep)` again; false = the 401 stands.
   */
  async renew(ep: AempEndpoint, sent: Record<string, string>): Promise<boolean> {
    if (ep.auth === 'oauth2') {
      tokenCache.delete(cacheKey(ep));
      await this.oauth2Token(ep, true);
      return true;
    }
    if (ep.auth === 'deere_oauth' && this.deere) {
      const rejected = (sent.authorization ?? '').replace(/^Bearer\s+/i, '');
      try {
        return (await this.deere.store.refreshAfterReject(rejected, this.deere.refresher)) !== null;
      } catch (e) {
        if (e instanceof OAuthReconnectError) {
          throw new AempAuthError(ep.id, `${e.message} (the Deere grant)`);
        }
        throw e;
      }
    }
    return false;
  }
}
