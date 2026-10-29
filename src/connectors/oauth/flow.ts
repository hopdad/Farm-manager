/**
 * Browser side of the OAuth connect flow (/api/oauth/<source>): the CSRF `state` cookie and the
 * small HTML pages. The app's /api/oauth routes never answer 3xx (contracts §5), so "go sign
 * in" is a 200 page with a link (and a meta refresh), not a redirect.
 */
import { timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export function stateCookieName(source: string): string {
  return `farm_oauth_${source}`;
}

/** Set-Cookie for the state (HttpOnly, SameSite=Lax so the vendor's redirect back carries it). */
export function stateCookie(source: string, state: string, secure: boolean): string {
  return [
    `${stateCookieName(source)}=${state}`,
    `Path=/api/oauth/${source}`,
    `Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearStateCookie(source: string, secure: boolean): string {
  return [
    `${stateCookieName(source)}=`,
    `Path=/api/oauth/${source}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The cookie's value from a Cookie header. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function statesMatch(expected: string | null, got: string | null): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A minimal standalone page (these routes sit outside the app layout). */
export function oauthPage(title: string, bodyHtml: string, refreshTo?: string): string {
  const refresh = refreshTo ? `<meta http-equiv="refresh" content="0;url=${esc(refreshTo)}">` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#0f1a12;color:#e7f0e9}
main{max-width:520px;margin:48px auto}a{color:#86efac}h1{font-size:24px}</style>
</head><body><main><h1>${esc(title)}</h1>${bodyHtml}</main></body></html>`;
}

export function escapeHtml(s: string): string {
  return esc(s);
}
