/**
 * GET /api/oauth/<source>: connect a vendor account (M0: Deere).
 *
 *   /api/oauth/deere                  start: set the CSRF state cookie, show "Continue to Deere"
 *                                     (a link + meta refresh to the authorize URL; never 3xx)
 *   /api/oauth/deere?code=&state=     callback: check state, exchange the code, store the
 *                                     tokens encrypted in ingest.oauth_tokens, show "Connected"
 *   /api/oauth/deere?error=…          the person declined at the consent page
 *
 * In sim mode the authorize URL is the stand-in's "Sign in to Deere (simulated)" page; the
 * redirect URI is `${PUBLIC_URL}/api/oauth/deere` (register it with Deere for sandbox/live).
 * The fleet.deere job doesn't need this in sim mode (it connects unattended), but this is the
 * path a real account takes. Outside sim mode starting the flow needs the admin cookie
 * (src/platform/auth/admin-key.ts): someone on the shop Wi-Fi must not be able to link another
 * Deere account over the farm's grant. The callback is bound to that start by the state cookie.
 */
import { getConfig } from '@/config';
import { deereAuthorizeUrl, exchangeDeereCode, newOAuthState } from '@/connectors/deere/oauth';
import { ConnectorModeError, deereEndpoints } from '@/connectors/endpoints';
import { tokenKey } from '@/connectors/oauth/crypto';
import {
  clearStateCookie,
  escapeHtml,
  oauthPage,
  readCookie,
  stateCookie,
  stateCookieName,
  statesMatch,
} from '@/connectors/oauth/flow';
import { OAuthTokenStore, userGrantOrg } from '@/connectors/oauth/token-store';
import { getPool } from '@/db/client';
import { ADMIN_COOKIE, ADMIN_LOCKED_MESSAGE, isAdminKey } from '@/platform/auth/admin-key';
import { limitedBytes } from '@/platform/http/limits';

export const dynamic = 'force-dynamic';

function page(status: number, title: string, body: string, extra: Record<string, string> = {}) {
  return limitedBytes(oauthPage(title, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
): Promise<Response> {
  const { source } = await params;
  if (source !== 'deere') {
    return page(404, 'Unknown connector', `<p>No sign-in flow for “${escapeHtml(source)}”.</p>`);
  }
  const cfg = getConfig();
  let ep: ReturnType<typeof deereEndpoints>;
  try {
    ep = deereEndpoints(cfg.CONNECTOR_DEERE, cfg);
  } catch (e) {
    const msg = e instanceof ConnectorModeError ? e.message : 'Deere is not configured';
    return page(409, 'Deere is not available', `<p>${escapeHtml(msg)}</p>`);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const secure = cfg.cookieSecure;

  if (error) {
    return page(
      400,
      'Deere sign-in cancelled',
      `<p>Deere answered <code>${escapeHtml(error)}</code>. <a href="/api/oauth/deere">Try again</a>.</p>`,
      { 'set-cookie': clearStateCookie('deere', secure) },
    );
  }

  if (!code) {
    if (!ep.sim && !isAdminKey(cfg, readCookie(request.headers.get('cookie'), ADMIN_COOKIE))) {
      return page(403, 'Admin is locked', `<p>${escapeHtml(ADMIN_LOCKED_MESSAGE)}.</p>`);
    }
    const state = newOAuthState();
    const authorize = deereAuthorizeUrl(ep, state);
    return limitedBytes(
      oauthPage(
        'Connect John Deere',
        `<p>${ep.sim ? 'Sim mode: this opens the local stand-in, not John Deere.' : 'You will sign in at John Deere and approve this app.'}</p>
<p><a href="${escapeHtml(authorize)}">Continue to Deere</a></p>`,
        authorize,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': stateCookie('deere', state, secure),
        },
      },
    );
  }

  const expected = readCookie(request.headers.get('cookie'), stateCookieName('deere'));
  if (!statesMatch(expected, url.searchParams.get('state'))) {
    return page(
      400,
      'Sign-in expired',
      '<p>The sign-in state did not match (expired or opened in another browser). <a href="/api/oauth/deere">Start again</a>.</p>',
      { 'set-cookie': clearStateCookie('deere', secure) },
    );
  }
  try {
    const tokens = await exchangeDeereCode(ep, code);
    const store = new OAuthTokenStore({
      pool: getPool(),
      source: 'deere',
      org: userGrantOrg(ep),
      key: tokenKey(cfg.TOKEN_ENC_KEY),
    });
    await store.save(tokens);
  } catch (e) {
    console.error('[api/oauth/deere]', (e as Error).message);
    return page(
      502,
      'Deere sign-in failed',
      `<p>${escapeHtml((e as Error).message)}</p><p><a href="/api/oauth/deere">Try again</a></p>`,
      { 'set-cookie': clearStateCookie('deere', secure) },
    );
  }
  return page(
    200,
    'Connected to John Deere',
    `<p>${ep.sim ? 'Connected to the simulated Deere account.' : 'Deere is connected.'} Machine locations sync on the next fleet.deere run.</p>
<p><a href="/admin/connectors">Connectors</a> · <a href="/board">Board</a></p>`,
    { 'set-cookie': clearStateCookie('deere', secure) },
  );
}
