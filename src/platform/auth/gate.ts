/**
 * What src/proxy.ts decides for a page request (pure apart from token verification, so it is
 * unit-tested without Next):
 *
 *  - pages need SOME identity: an enrolled device, a signed-in person, or the PC's admin cookie.
 *    A page request with none is redirected to /login (which offers "enroll this screen" and
 *    "sign in"), never shown an error. Role checks stay in the pages and handlers.
 *  - never redirected: /login, /enroll, /admin/unlock (and, by the proxy's matcher, every
 *    /api/** path, /_next/** and static files: a signed-out API call gets 401 JSON from
 *    requireRole, and pg_cron, the clock, webhooks and MapLibre never see a 3xx);
 *  - only GET and HEAD redirect: a server action POST without identity runs and is refused by
 *    its own requireRole (a redirected POST would replay against /login);
 *  - sliding lifetimes: the base credential is re-issued once a day and the operator layer every
 *    10 minutes while pages are used, so an always-on wall stays enrolled and an operator who
 *    walks away is signed out after PIN_RULES.operatorIdleMinutes.
 *
 * Only the signature and expiry are checked here (no database), like Supabase's getClaims() in
 * the MD proxy; whether the device or person still stands is checked by getSession().
 */
import {
  OPERATOR_REFRESH_AFTER_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
  SESSION_TTL_SECONDS,
} from './cookies';
import { OPERATOR_TTL_SECONDS } from './operator';
import { signIdentity, signOperator, verifyIdentity, verifyOperator } from './tokens';

/** Paths a browser with no identity may open. */
export const PUBLIC_PAGE_PATHS = ['/login', '/enroll', '/admin/unlock'] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** `/login?next=<the page>` (no `next` for the root; Next's `_rsc` cache-buster dropped). */
export function loginRedirect(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const qs = params.toString();
  const target = `${pathname}${qs ? `?${qs}` : ''}`;
  return target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`;
}

export interface GateInput {
  secret: string;
  method: string;
  pathname: string;
  search: string;
  authCookie: string | undefined;
  operatorCookie: string | undefined;
  /** The request carries a valid admin cookie (src/platform/auth/admin-key.ts). */
  adminKey: boolean;
  now: Date;
}

export interface CookieRefresh {
  value: string;
  maxAge: number;
}

export type GateDecision =
  | { action: 'redirect'; location: string }
  | { action: 'next'; refresh: { auth?: CookieRefresh; operator?: CookieRefresh } };

export async function decideGate(input: GateInput): Promise<GateDecision> {
  const base = await verifyIdentity(input.secret, input.authCookie, input.now);
  if (!base && !input.adminKey && !isPublicPath(input.pathname)) {
    if (input.method === 'GET' || input.method === 'HEAD') {
      return { action: 'redirect', location: loginRedirect(input.pathname, input.search) };
    }
  }
  const refresh: { auth?: CookieRefresh; operator?: CookieRefresh } = {};
  if (!base) return { action: 'next', refresh };
  const nowS = Math.floor(input.now.getTime() / 1000);
  if (nowS - base.times.iat >= SESSION_REFRESH_AFTER_SECONDS) {
    const ttl =
      base.identity.kind === 'device' ? SESSION_TTL_SECONDS.device : SESSION_TTL_SECONDS.person;
    refresh.auth = {
      value: await signIdentity(input.secret, base.identity, input.now, ttl),
      maxAge: ttl,
    };
  }
  if (base.identity.kind === 'device' && input.operatorCookie) {
    const op = await verifyOperator(input.secret, input.operatorCookie, input.now);
    if (
      op &&
      op.operator.deviceId === base.identity.deviceId &&
      nowS - op.times.iat >= OPERATOR_REFRESH_AFTER_SECONDS
    ) {
      refresh.operator = {
        value: await signOperator(input.secret, op.operator, input.now, OPERATOR_TTL_SECONDS),
        maxAge: OPERATOR_TTL_SECONDS,
      };
    }
  }
  return { action: 'next', refresh };
}
