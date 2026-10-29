/**
 * The local session cookies (plan §1 "Auth", docs/contracts-m1.md §4). Two cookies, both signed
 * JWTs (./tokens.ts), both httpOnly + SameSite=Lax + Path=/:
 *
 *  - `farm_auth`: the PROVIDER's base credential (LocalAuth): an enrolled device or a person.
 *    At MD the Supabase provider keeps its own cookies instead; this one is local-only.
 *  - `farm_op`:   the OPERATOR layer on a shared device (wall, cab/truck iPad): who picked their
 *    name and entered a PIN. Same code with either provider.
 *
 * `Secure` follows PUBLIC_URL (`cfg.cookieSecure`), never NODE_ENV: `pnpm pilot` is a
 * production build served over http://<lan-ip> on the shop Wi-Fi, where a Secure cookie would
 * silently never come back. SameSite=Lax (not Strict): the enrollment link opened from a QR code
 * or a text message is a cross-site top-level navigation and must arrive signed in.
 */
import type { CookieJar } from './types';

export const AUTH_COOKIE = 'farm_auth';
export const OPERATOR_COOKIE = 'farm_op';

/** Browsers cap cookie lifetimes at 400 days (RFC 6265bis); the token inside says the rest. */
export const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 3600;

/** How long each credential lasts. Refreshed (sliding) by src/proxy.ts on page requests. */
export const SESSION_TTL_SECONDS = Object.freeze({
  /** An enrolled device stays enrolled until revoked: a year, renewed daily while in use. */
  device: 365 * 24 * 3600,
  /** A person's own browser or phone: 30 days, renewed daily while in use. */
  person: 30 * 24 * 3600,
});

/** Re-issue a base credential once it is this old (proxy). */
export const SESSION_REFRESH_AFTER_SECONDS = 24 * 3600;
/** Re-issue the operator layer once it is this old, so its idle window slides (proxy). */
export const OPERATOR_REFRESH_AFTER_SECONDS = 10 * 60;

export type CookieOptions = Parameters<CookieJar['set']>[2];

/** Options of both session cookies. */
export function sessionCookieOptions(secure: boolean, maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, Math.min(Math.floor(maxAge), MAX_COOKIE_AGE_SECONDS)),
  };
}
