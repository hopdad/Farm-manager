/**
 * Cross-site request check for route handlers that change data (contracts-m1 §2
 * "Authorization": requireRole first, then this). Server actions get Next's own Origin check;
 * route handlers don't.
 *
 * Is the request from a page of this app, or not from a browser page at all? Browsers send
 * `Origin` on every POST, PUT, PATCH and DELETE; it must name the host the request came to: the
 * LAN address a phone used, localhost on the PC, or the production domain behind Vercel's
 * `x-forwarded-host`. A request without `Origin` (curl, the clock, a test) passes: it carries
 * no browser cookies by accident. Session cookies are SameSite=Lax, but "same site" ignores the
 * port, so another service on the PC's address could otherwise post with them.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host.split(',')[0]?.trim();
  } catch {
    return false;
  }
}
