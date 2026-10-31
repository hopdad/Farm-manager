/**
 * The MyGeotab session and the client-side rate limits (slice 1f.2, the trucks builder;
 * docs/contracts-1f.md §B.1).
 *
 * SESSION. Authenticate (database, `userName`, password) returns credentials with a
 * `sessionId` that every later call carries instead of the password; it lives up to 14 days and
 * ends early on a password change, the 100-session cap or a server restart (Geotab's Concepts
 * page and its Service accounts article). One session is reused across runs: it is kept in
 * ingest.oauth_tokens through the OAuth token store (source `geotab`, encrypted with
 * TOKEN_ENC_KEY), its access token being this JSON (session id, database, user, and the server
 * `LoginResult.path` named). The store's locked refresh is the re-authentication: under its
 * advisory lock exactly one caller authenticates when the session is near its end or was just
 * rejected (InvalidUserException), and the rest read its result. The "refresh token" is a fixed
 * marker (`reauthenticate`), never the password: the password stays in config.
 *
 * LIMITS. Geotab counts per method, entity type, user and database (Rate Limits guide; api.json
 * `rateLimit`): Authenticate 10/min, GetFeed 60/min per entity type. The client keeps its own
 * sliding windows per process so it never needs the server to say OverLimitException.
 */
import type { GeotabEndpoint } from '../endpoints';
import { MemoryTokenStore } from '../oauth/memory-store';
import type { OAuthTokens, TokenStore } from '../oauth/token-store';

export interface GeotabSession {
  sessionId: string;
  database: string;
  userName: string;
  /** The server LoginResult.path named (a host), or null: the configured server. */
  server: string | null;
}

/** What stands in for a refresh token: the client re-authenticates with the configured user. */
export const GEOTAB_REAUTH_MARKER = 'reauthenticate';
/** A session lasts up to 14 days; renew a day early. */
export const GEOTAB_SESSION_DAYS = 13;
/** Authenticate per user and database per minute (api.json WebMethods.Authenticate). */
export const GEOTAB_AUTHENTICATE_PER_MINUTE = 10;
/** GetFeed per entity type, user and database per minute (LogRecord, StatusData, FaultData). */
export const GEOTAB_GETFEED_PER_MINUTE = 60;

export function encodeSession(s: GeotabSession): string {
  return JSON.stringify({ s: s.sessionId, d: s.database, u: s.userName, h: s.server });
}

export function decodeSession(token: string): GeotabSession | null {
  try {
    const v = JSON.parse(token) as { s?: unknown; d?: unknown; u?: unknown; h?: unknown };
    if (typeof v.s !== 'string' || typeof v.d !== 'string' || typeof v.u !== 'string') return null;
    return {
      sessionId: v.s,
      database: v.d,
      userName: v.u,
      server: typeof v.h === 'string' && v.h ? v.h : null,
    };
  } catch {
    return null;
  }
}

export function sessionTokens(s: GeotabSession, now: Date): OAuthTokens {
  return {
    accessToken: encodeSession(s),
    refreshToken: GEOTAB_REAUTH_MARKER,
    tokenType: 'geotab-session',
    expiresAt: new Date(now.getTime() + GEOTAB_SESSION_DAYS * 86_400_000),
    refreshExpiresAt: null,
    scopes: [],
  };
}

/**
 * ingest.oauth_tokens org_external_id of a configured service user: one row per server,
 * database and user, so switching the user or the database starts a new session (and sim's
 * stand-in session never meets a real one).
 */
export function geotabSessionOrg(ep: Pick<GeotabEndpoint, 'server' | 'database' | 'username'>) {
  return `${ep.server}/${ep.database}/${ep.username}`;
}

/** A host LoginResult.path may name (`my3.geotab.com`, `127.0.0.1:4010`), else null. */
export function serverFromPath(path: string | null | undefined): string | null {
  const p = (path ?? '').trim();
  if (!p || p.toLowerCase() === 'thisserver') return null;
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(p) ? p.toLowerCase() : null;
}

const memoryStores = new Map<string, MemoryTokenStore>();

/** A per-process session store (sim without TOKEN_ENC_KEY, tests): sessions survive runs. */
export function memorySessionStore(org: string): TokenStore {
  let s = memoryStores.get(org);
  if (!s) {
    s = new MemoryTokenStore('geotab');
    memoryStores.set(org, s);
  }
  return s;
}

// ---- Sliding-window limits (per process) ------------------------------------------------------

const windows = new Map<string, number[]>();
const MINUTE = 60_000;

function prune(key: string, now: number): number[] {
  const w = (windows.get(key) ?? []).filter((t) => now - t < MINUTE);
  windows.set(key, w);
  return w;
}

/** Calls left for `key` in the current minute. */
export function callsLeft(key: string, limit: number, now: number): number {
  return Math.max(0, limit - prune(key, now).length);
}

/** Seconds until one more call fits (0 = now). */
export function secondsUntilFree(key: string, limit: number, now: number): number {
  const w = prune(key, now);
  if (w.length < limit) return 0;
  const oldest = w[w.length - limit] as number;
  return Math.max(1, Math.ceil((oldest + MINUTE - now) / 1000));
}

/** Count one call for `key`. */
export function countCall(key: string, now: number): void {
  prune(key, now).push(now);
}

/** Forget every window (tests). */
export function resetGeotabLimits(): void {
  windows.clear();
}
