/**
 * Next 16 proxy (plan §1 "proxy.ts session refresh"; docs/contracts-m1.md §4). Runs on page
 * requests only:
 *
 *  - a page request from a browser with no identity at all (no enrolled device, no signed-in
 *    person, no admin cookie) is redirected to /login, which shows "enroll this screen" and
 *    "sign in" instead of an error; /login, /enroll and /admin/unlock never redirect;
 *  - while pages are used, it slides the session cookies' lifetimes (src/platform/auth/gate.ts).
 *
 * It NEVER runs on /api/** (the matcher below): /api/tiles, /api/jobs, /api/webhooks, /api/oauth
 * and /api/realtime must never answer 3xx (pg_net, the clock, vendors and MapLibre don't follow
 * redirects; e2e/routes.spec.ts), and a signed-out API call gets its 401 JSON from requireRole.
 * Nor on /_next/** or static files. Authorization itself happens in every page, route handler
 * and server action (requireRole), never here.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { tryGetConfig } from './config';
import { ADMIN_COOKIE, isAdminKey } from './platform/auth/admin-key';
import { AUTH_COOKIE, OPERATOR_COOKIE, sessionCookieOptions } from './platform/auth/cookies';
import { decideGate } from './platform/auth/gate';

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const loaded = tryGetConfig();
  // A fresh clone without .env.local: let the page show its own configuration error.
  if (!loaded.ok || loaded.config.AUTH_PROVIDER !== 'local') return NextResponse.next();
  const cfg = loaded.config;
  const decision = await decideGate({
    secret: cfg.SESSION_SECRET,
    method: request.method,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    authCookie: request.cookies.get(AUTH_COOKIE)?.value,
    operatorCookie: request.cookies.get(OPERATOR_COOKIE)?.value,
    adminKey: isAdminKey(cfg, request.cookies.get(ADMIN_COOKIE)?.value),
    now: new Date(),
  });
  if (decision.action === 'redirect') {
    // Built from the request's own URL, so the browser stays on the host it used (localhost on
    // the PC, the LAN address on a phone); Next sends same-origin redirects as relative paths.
    const target = new URL(decision.location, request.nextUrl);
    const res = NextResponse.redirect(target, 307);
    res.headers.set('cache-control', 'no-store');
    return res;
  }
  const res = NextResponse.next();
  const { auth, operator } = decision.refresh;
  if (auth) {
    res.cookies.set(AUTH_COOKIE, auth.value, sessionCookieOptions(cfg.cookieSecure, auth.maxAge));
  }
  if (operator) {
    res.cookies.set(
      OPERATOR_COOKIE,
      operator.value,
      sessionCookieOptions(cfg.cookieSecure, operator.maxAge),
    );
  }
  return res;
}

export const config = {
  // Everything but /api (and /api/**), /_next/** and files with an extension (static assets,
  // /sw.js, /manifest.webmanifest, /favicon.ico).
  matcher: ['/((?!api/|api$|_next/|.*\\.[A-Za-z0-9]+$).*)'],
};
