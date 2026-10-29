/**
 * Server auth helpers (docs/contracts-m1.md §4): getSession(), requireRole(min),
 * authErrorResponse(e), for server components, route handlers and server actions.
 *
 * A request's session, in order:
 *  1. a test override (`runWithSession`, ./testing.ts; tests only);
 *  2. the M0 admin cookie (`farm_admin`, ./admin-key.ts): on the PC a valid admin cookie is a
 *     provisional OWNER session that wins over any other identity on that browser (decided,
 *     contracts §4). Never valid in production (`isAdminKey` is false there);
 *  3. the provider's identity (AUTH_PROVIDER; LocalAuth's `farm_auth` cookie) plus, on a shared
 *     device, the operator layer (`farm_op`), checked against the database on every request
 *     (revoked devices, epoch bumps, people switched off, roles changed: ./session.ts);
 *  4. otherwise null: signed out. `requireRole` then throws AuthError(401).
 *
 * Cached per request (React `cache`), so a page and the components it renders share one lookup.
 */
import { cookies } from 'next/headers';
import { cache } from 'react';
import { getConfig } from '../../config';
import { getPool } from '../../db/client';
import { limitedJson } from '../http/limits';
import { ADMIN_COOKIE, isAdminKey } from './admin-key';
import { getAuthProvider } from './provider';
import { type BrowserAuth, resolveBrowserAuth } from './resolve';
import { sessionOverride } from './testing';
import { AuthError, checkRole, type Role, type Session } from './types';

export type { Role, Session } from './types';
export { AuthError, isAuthError, ROLE_FOR, roleAtLeast } from './types';

/** The admin-key holder's session (provisional owner; local PC only). */
export const ADMIN_KEY_SESSION: Readonly<Session> = Object.freeze({
  kind: 'person',
  deviceId: null,
  appUserId: null,
  partyId: null,
  role: 'owner',
  displayName: 'Admin key',
  deviceKind: null,
  provisional: true,
});

/** This request's full auth state (the /login page needs more than the Session). */
export const getBrowserAuth = cache(async (): Promise<BrowserAuth & { adminKey: boolean }> => {
  const jar = await cookies();
  const cfg = getConfig();
  if (isAdminKey(cfg, jar.get(ADMIN_COOKIE)?.value)) {
    return {
      session: { ...ADMIN_KEY_SESSION },
      identity: null,
      stale: false,
      sharedDevice: null,
      operatorSignedIn: false,
      adminKey: true,
    };
  }
  const auth = await resolveBrowserAuth({
    provider: getAuthProvider(cfg),
    secret: cfg.SESSION_SECRET,
    cookies: jar,
    ex: getPool(),
    now: new Date(),
  });
  return { ...auth, adminKey: false };
});

/**
 * The request's session, or null when nobody is signed in. Server components, route handlers
 * and server actions only (it reads the request's cookies). Never throws for a bad, expired or
 * revoked credential (null instead); a database outage does throw.
 */
export async function getSession(): Promise<Session | null> {
  const override = sessionOverride();
  if (override !== undefined) return override;
  return (await getBrowserAuth()).session;
}

/**
 * The session when its role is at least `min`; else throws AuthError(401) (no session) or
 * AuthError(403) (role too low). Call it FIRST in every mutation and private read.
 */
export async function requireRole(min: Role): Promise<Session> {
  return checkRole(await getSession(), min);
}

/**
 * For route handlers: the JSON response for an AuthError (401 / 403, `Cache-Control:
 * no-store`), or null for any other error (rethrow it).
 *
 *   try { const s = await requireRole('driver'); … } catch (e) {
 *     const res = authErrorResponse(e); if (res) return res; throw e;
 *   }
 */
export function authErrorResponse(e: unknown): Response | null {
  if (!(e instanceof AuthError)) return null;
  return limitedJson(
    { error: e.message, status: e.status, required: e.required },
    { status: e.status, headers: { 'cache-control': 'no-store' } },
  );
}
