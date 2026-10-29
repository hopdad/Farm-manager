/**
 * In-memory TokenStore with the same refresh rules as OAuthTokenStore (one refresher at a time,
 * re-check after taking the lock), for unit tests and offline tools. Never used by the app.
 */
import type { ConnectorSource } from '../types';
import {
  isInvalidGrant,
  OAuthReconnectError,
  type OAuthTokens,
  type TokenRefresher,
  type TokenStore,
} from './token-store';

export class MemoryTokenStore implements TokenStore {
  readonly source: ConnectorSource;
  tokens: OAuthTokens | null;
  /** Token-endpoint refreshes this store performed. */
  refreshes = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly skewMs: number;

  constructor(
    source: ConnectorSource,
    tokens: OAuthTokens | null = null,
    opts: { now?: () => Date; skewSeconds?: number } = {},
  ) {
    this.source = source;
    this.tokens = tokens;
    this.now = opts.now ?? (() => new Date());
    this.skewMs = (opts.skewSeconds ?? 60) * 1000;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private nearExpiry(t: OAuthTokens): boolean {
    return t.expiresAt.getTime() - this.skewMs <= this.now().getTime();
  }

  private refreshIf(need: (t: OAuthTokens) => boolean, refresher: TokenRefresher) {
    return this.locked(async () => {
      const cur = this.tokens;
      if (!cur || !need(cur)) return cur?.accessToken ?? null;
      if (!cur.refreshToken) {
        this.tokens = null;
        throw new OAuthReconnectError(this.source, 'refresh token missing');
      }
      try {
        const next = await refresher(cur.refreshToken);
        this.refreshes++;
        this.tokens = { ...next, refreshToken: next.refreshToken ?? cur.refreshToken };
        return this.tokens.accessToken;
      } catch (e) {
        if (!isInvalidGrant(e)) throw e;
        this.tokens = null;
        throw new OAuthReconnectError(this.source, 'refresh token rejected');
      }
    });
  }

  async accessToken(refresher: TokenRefresher): Promise<string | null> {
    const t = this.tokens;
    if (!t) return null;
    if (!this.nearExpiry(t)) return t.accessToken;
    return this.refreshIf((cur) => this.nearExpiry(cur), refresher);
  }

  refreshAfterReject(rejected: string, refresher: TokenRefresher): Promise<string | null> {
    return this.refreshIf((cur) => cur.accessToken === rejected, refresher);
  }

  async save(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
  }
}
