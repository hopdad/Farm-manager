/**
 * OAuth tokens in ingest.oauth_tokens (one row per (source, org_external_id)), encrypted with
 * TOKEN_ENC_KEY, refreshed under a transaction-scoped advisory lock (plan §5):
 *
 *   begin;
 *   select pg_advisory_xact_lock(hashtext('oauth:' || source || ':' || org));
 *   select … from ingest.oauth_tokens where … for update;   -- re-read AFTER the lock
 *   -- refresh only if still near expiry (or still the token the vendor just rejected)
 *   update …; commit;
 *
 * Vendors that ROTATE refresh tokens (QBO, the Deere stand-in) invalidate the old one on use,
 * so two refreshers would log the app out; the lock makes exactly one of N concurrent callers
 * (any process) call the token endpoint, and the rest read its result.
 *
 * Deere: one row per connected Deere user with org_external_id '' (a user token sees every org
 * that approved the connection). QBO (M3) will use the realm id.
 */
import type pg from 'pg';
import type { ConnectorSource } from '../types';
import { decryptSecret, encryptSecret } from './crypto';

export interface OAuthTokens {
  accessToken: string;
  /** Null when the vendor issued none (no offline access). */
  refreshToken: string | null;
  tokenType: string;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
  scopes: string[];
}

/** Exchanges a refresh token for new tokens (the vendor's token endpoint). */
export type TokenRefresher = (refreshToken: string) => Promise<OAuthTokens>;

/** What a vendor client needs from a token store (OAuthTokenStore; MemoryTokenStore in tests). */
export interface TokenStore {
  readonly source: ConnectorSource;
  /** A usable access token (refreshing when near expiry), or null when not connected. */
  accessToken(refresher: TokenRefresher): Promise<string | null>;
  /** The vendor rejected `rejected`: refresh unless someone already did; token to retry with. */
  refreshAfterReject(rejected: string, refresher: TokenRefresher): Promise<string | null>;
  /** Store a fresh grant. */
  save(tokens: OAuthTokens): Promise<void>;
}

/** The grant is gone (revoked, expired, or rotated away): a person must sign in again. */
export class OAuthReconnectError extends Error {
  readonly source: string;
  constructor(source: string, reason: string) {
    super(`${source}: ${reason}; sign in again at /api/oauth/${source}`);
    this.name = 'OAuthReconnectError';
    this.source = source;
  }
}

/** True when an error from a refresher means the refresh token itself is dead. */
export function isInvalidGrant(e: unknown): boolean {
  const err = e as { oauthError?: unknown; status?: unknown } | null;
  return err?.oauthError === 'invalid_grant';
}

interface Row {
  ciphertext: string;
  expires_at: Date | null;
  refresh_expires_at: Date | null;
  scopes: string[];
}

interface Secret {
  a: string;
  r: string | null;
  t: string;
}

export interface OAuthTokenStoreOptions {
  pool: pg.Pool;
  source: ConnectorSource;
  /** org_external_id ('' for user-level grants). */
  org?: string;
  key: Buffer;
  now?: () => Date;
  /** Refresh this long before expiry. Default 60 s. */
  skewSeconds?: number;
}

export class OAuthTokenStore implements TokenStore {
  readonly source: ConnectorSource;
  readonly org: string;
  private readonly pool: pg.Pool;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly skewMs: number;

  constructor(opts: OAuthTokenStoreOptions) {
    this.pool = opts.pool;
    this.source = opts.source;
    this.org = opts.org ?? '';
    this.key = opts.key;
    this.now = opts.now ?? (() => new Date());
    this.skewMs = (opts.skewSeconds ?? 60) * 1000;
  }

  private get aad(): string {
    return `${this.source}|${this.org}`;
  }

  private get lockKey(): string {
    return `oauth:${this.source}:${this.org}`;
  }

  private decode(row: Row): OAuthTokens {
    const s = JSON.parse(decryptSecret(this.key, row.ciphertext, this.aad)) as Secret;
    return {
      accessToken: s.a,
      refreshToken: s.r,
      tokenType: s.t,
      expiresAt: row.expires_at ?? new Date(0),
      refreshExpiresAt: row.refresh_expires_at,
      scopes: row.scopes,
    };
  }

  private async readWith(
    ex: pg.Pool | pg.PoolClient,
    forUpdate: boolean,
  ): Promise<OAuthTokens | null> {
    const r = await ex.query<Row>(
      `select ciphertext, expires_at, refresh_expires_at, scopes from ingest.oauth_tokens
        where source = $1 and org_external_id = $2${forUpdate ? ' for update' : ''}`,
      [this.source, this.org],
    );
    const row = r.rows[0];
    return row ? this.decode(row) : null;
  }

  private async saveWith(ex: pg.Pool | pg.PoolClient, t: OAuthTokens): Promise<void> {
    const secret: Secret = { a: t.accessToken, r: t.refreshToken, t: t.tokenType };
    await ex.query(
      `insert into ingest.oauth_tokens
         (source, org_external_id, ciphertext, expires_at, refresh_expires_at, scopes)
       values ($1, $2, $3, $4, $5, $6::text[])
       on conflict (source, org_external_id) do update
         set ciphertext = excluded.ciphertext, expires_at = excluded.expires_at,
             refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes,
             updated_at = now()`,
      [
        this.source,
        this.org,
        encryptSecret(this.key, JSON.stringify(secret), this.aad),
        t.expiresAt,
        t.refreshExpiresAt,
        t.scopes,
      ],
    );
  }

  /** The stored tokens, or null when not connected. */
  read(): Promise<OAuthTokens | null> {
    return this.readWith(this.pool, false);
  }

  /** Store a fresh grant (OAuth callback, sim auto-consent). */
  save(tokens: OAuthTokens): Promise<void> {
    return this.saveWith(this.pool, tokens);
  }

  async remove(): Promise<void> {
    await this.pool.query(
      'delete from ingest.oauth_tokens where source = $1 and org_external_id = $2',
      [this.source, this.org],
    );
  }

  private nearExpiry(t: OAuthTokens): boolean {
    return t.expiresAt.getTime() - this.skewMs <= this.now().getTime();
  }

  /**
   * A usable access token: the stored one while it is fresh, else refreshed under the lock.
   * Null when not connected. Throws OAuthReconnectError when the refresh token is dead (the row
   * is deleted so the next attempt starts a new grant).
   */
  async accessToken(refresher: TokenRefresher): Promise<string | null> {
    const t = await this.read();
    if (!t) return null;
    if (!this.nearExpiry(t)) return t.accessToken;
    return this.lockedRefresh((cur) => this.nearExpiry(cur), refresher);
  }

  /**
   * The vendor rejected `rejected` (401): refresh unless another caller already replaced it.
   * Returns the token to retry with (null when not connected).
   */
  refreshAfterReject(rejected: string, refresher: TokenRefresher): Promise<string | null> {
    return this.lockedRefresh((cur) => cur.accessToken === rejected, refresher);
  }

  private async lockedRefresh(
    needsRefresh: (current: OAuthTokens) => boolean,
    refresher: TokenRefresher,
  ): Promise<string | null> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query('begin');
      open = true;
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [this.lockKey]);
      const cur = await this.readWith(client, true);
      if (!cur || !needsRefresh(cur)) {
        await client.query('commit');
        open = false;
        return cur?.accessToken ?? null;
      }
      const deadRefresh =
        !cur.refreshToken ||
        (cur.refreshExpiresAt !== null && cur.refreshExpiresAt.getTime() <= this.now().getTime());
      let next: OAuthTokens | null = null;
      let reconnect: string | null = deadRefresh ? 'refresh token missing or expired' : null;
      if (!deadRefresh) {
        try {
          next = await refresher(cur.refreshToken as string);
        } catch (e) {
          if (!isInvalidGrant(e)) throw e;
          reconnect = 'refresh token rejected (revoked, expired or already used)';
        }
      }
      if (reconnect || !next) {
        await client.query(
          'delete from ingest.oauth_tokens where source = $1 and org_external_id = $2',
          [this.source, this.org],
        );
        await client.query('commit');
        open = false;
        throw new OAuthReconnectError(this.source, reconnect ?? 'refresh failed');
      }
      // Vendors that don't rotate omit refresh_token: keep the one we have.
      const merged: OAuthTokens = { ...next, refreshToken: next.refreshToken ?? cur.refreshToken };
      await this.saveWith(client, merged);
      await client.query('commit');
      open = false;
      return merged.accessToken;
    } finally {
      if (open) await client.query('rollback').catch(() => {});
      client.release();
    }
  }
}
