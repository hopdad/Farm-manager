/**
 * Server auth helpers: getSession(), requireRole(min), authErrorResponse(e).
 *
 * PLACEHOLDER (contracts stage). The auth builder replaces the implementation with LocalAuth +
 * the operator PIN layer (1a) and MUST keep these exports and their behaviour contract
 * (src/platform/auth/types.ts). Until then, so every other builder's code compiles, runs and is
 * already authorized at the right places:
 *  - a request carrying the M0 admin cookie (src/platform/auth/admin-key.ts; never valid in
 *    production) is a provisional OWNER session ("Admin key");
 *  - any other request is the provisional ANONYMOUS_VIEWER;
 *  - tests run code under a chosen session with `runWithSession` (./testing.ts).
 *
 * So `requireRole('viewer')` passes for everyone now and starts answering 401 for signed-out
 * requests the day the real implementation lands; `requireRole('driver')` and above need the
 * admin cookie (e2e: `unlockAdmin(context)` from e2e/support/admin.ts) until then.
 */
import { cookies } from 'next/headers';
import { getConfig } from '../../config';
import { limitedJson } from '../http/limits';
import { ADMIN_COOKIE, isAdminKey } from './admin-key';
import { sessionOverride } from './testing';
import { ANONYMOUS_VIEWER, AuthError, checkRole, type Role, type Session } from './types';

export type { Role, Session } from './types';
export { AuthError, isAuthError, ROLE_FOR, roleAtLeast } from './types';

const ADMIN_KEY_SESSION: Readonly<Session> = Object.freeze({
  kind: 'person',
  deviceId: null,
  appUserId: null,
  partyId: null,
  role: 'owner',
  displayName: 'Admin key',
  deviceKind: null,
  provisional: true,
});

/**
 * The request's session, or null when nobody is signed in. Server components, route handlers
 * and server actions only (it reads the request's cookies).
 */
export async function getSession(): Promise<Session | null> {
  const override = sessionOverride();
  if (override !== undefined) return override;
  const jar = await cookies();
  if (isAdminKey(getConfig(), jar.get(ADMIN_COOKIE)?.value)) return { ...ADMIN_KEY_SESSION };
  return { ...ANONYMOUS_VIEWER };
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
