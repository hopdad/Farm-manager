/**
 * The per-install admin key: M0's lock on /admin/*. Since slice 1a the admin pages need a manager
 * (src/app/admin/_lib/guard.ts); the key stays as the PC-only way in (a provisional owner session,
 * docs/contracts-m1.md §4), for the person at the PC and the M0 e2e specs.
 *
 * Next listens on 0.0.0.0 so phones on the shop Wi-Fi can open /board and /m. Without a lock,
 * anyone on that network could also use /admin/* and its server actions (pause the job clock,
 * switch scenarios, inject faults, drop the LISTEN connection) and start the real Deere connect
 * flow. Next's server-action CSRF check doesn't help (it only compares Origin with Host), and
 * neither would a loopback check on Host, Origin or X-Forwarded-For: all client-controlled.
 *
 * So the key is a secret only the person at the PC sees: `pnpm dev` / `pnpm pilot` print
 * `http://localhost:<port>/admin/unlock?key=<key>`, which sets an HttpOnly, SameSite=Strict
 * cookie for that host (SameSite=Strict also defeats DNS rebinding). The key is derived from
 * SESSION_SECRET, so it is stable per install and changes when the secret does. Production
 * (APP_ENV=production) has no admin until real sign-in exists: the key never unlocks there.
 *
 * Pure (node:crypto only): the app, tools/dev.ts and the e2e suite share it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'farm_admin';
export const ADMIN_UNLOCK_PATH = '/admin/unlock';
export const ADMIN_LOCKED_MESSAGE =
  'admin needs a manager: sign in as a manager at /login, or open the Admin link `pnpm dev` (or `pnpm pilot`) printed on the PC';

/** The config an admin check needs. */
export interface AdminKeyConfig {
  SESSION_SECRET: string;
  isProduction: boolean;
}

/** The install's admin key (base64url HMAC of a fixed label under SESSION_SECRET). */
export function adminKey(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('farm-admin-m0').digest('base64url');
}

/** Does `candidate` unlock admin? Constant-time; always false in production. */
export function isAdminKey(cfg: AdminKeyConfig, candidate: string | null | undefined): boolean {
  if (cfg.isProduction || !candidate) return false;
  const want = Buffer.from(adminKey(cfg.SESSION_SECRET));
  const got = Buffer.from(candidate);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Set-Cookie value for the admin cookie (Path=/ so /api/oauth sees it too). */
export function adminCookie(key: string, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${key}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${400 * 24 * 3600}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The unlock link the launchers print (`base` = the app's origin as the PC opens it). */
export function adminUnlockUrl(base: string, sessionSecret: string): string {
  const url = new URL(ADMIN_UNLOCK_PATH, base);
  url.searchParams.set('key', adminKey(sessionSecret));
  return url.toString();
}
