/**
 * GET /api/oauth/cnh: connect a CNH FieldOps account (slice 1f.2; owner: the machines builder).
 * A static segment, so it answers before /api/oauth/[source] (sync-health's Deere flow).
 *
 *   /api/oauth/cnh                  start: set the CSRF state cookie, show "Continue to CNH" (a
 *                                   link + meta refresh to CNH's /authorize with all seven
 *                                   parameters, audience and connection of the environment;
 *                                   never 3xx)
 *   /api/oauth/cnh?code=&state=     callback: check the state, exchange the code (client secret in
 *                                   the form body), store the tokens encrypted in
 *                                   ingest.oauth_tokens (source cnh), show "Connected"
 *   /api/oauth/cnh?error=…          the person declined at CNH's consent page
 *
 * The redirect URI is CNH_REDIRECT_URI or `${PUBLIC_URL}/api/oauth/cnh` (register it on the
 * develop.cnh.com app; https in production). Outside sim mode starting the flow needs a manager
 * (ROLE_FOR.admin): someone on the shop Wi-Fi must not link another CNH account over the farm's
 * grant. The callback is bound to that start by the state cookie. CNH needs a staging recording
 * before sandbox or live use (src/connectors/cnh/doc-derived.ts).
 */
import { getConfig } from '@/config';
import { cnhAuthorizeUrl, cnhGrantOrg, exchangeCnhCode, newCnhState } from '@/connectors/cnh/oauth';
import { ConnectorModeError, cnhEndpoints } from '@/connectors/endpoints';
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
import { OAuthTokenStore } from '@/connectors/oauth/token-store';
import { getPool } from '@/db/client';
import { ADMIN_LOCKED_MESSAGE } from '@/platform/auth/admin-key';
import { getSession, ROLE_FOR, roleAtLeast } from '@/platform/auth/server';
import { limitedBytes } from '@/platform/http/limits';

export const dynamic = 'force-dynamic';

const SOURCE = 'cnh';

function page(status: number, title: string, body: string, extra: Record<string, string> = {}) {
  return limitedBytes(oauthPage(title, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export async function GET(request: Request): Promise<Response> {
  const cfg = getConfig();
  let ep: ReturnType<typeof cnhEndpoints>;
  try {
    ep = cnhEndpoints(cfg.CONNECTOR_CNH, cfg);
  } catch (e) {
    const msg = e instanceof ConnectorModeError ? e.message : 'CNH FieldOps is not configured';
    return page(409, 'CNH FieldOps is not available', `<p>${escapeHtml(msg)}</p>`);
  }
  const sim = ep.environment === 'sim';
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const secure = cfg.cookieSecure;

  if (error) {
    return page(
      400,
      'CNH sign-in cancelled',
      `<p>CNH answered <code>${escapeHtml(error)}</code>. <a href="/api/oauth/cnh">Try again</a>.</p>`,
      { 'set-cookie': clearStateCookie(SOURCE, secure) },
    );
  }

  if (!code) {
    const session = sim ? null : await getSession();
    if (!sim && !(session && roleAtLeast(session.role, ROLE_FOR.admin))) {
      return page(403, 'Admin is locked', `<p>${escapeHtml(ADMIN_LOCKED_MESSAGE)}.</p>`);
    }
    const state = newCnhState();
    const authorize = cnhAuthorizeUrl(ep, state);
    const where = sim
      ? 'Sim mode: this opens the local stand-in, not CNH.'
      : `You will sign in at CNH (${ep.environment}) with a FieldOps login that has the Farm Manager title, and approve this app.`;
    return limitedBytes(
      oauthPage(
        'Connect CNH FieldOps',
        `<p>${escapeHtml(where)}</p><p><a href="${escapeHtml(authorize)}">Continue to CNH</a></p>`,
        authorize,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': stateCookie(SOURCE, state, secure),
        },
      },
    );
  }

  const expected = readCookie(request.headers.get('cookie'), stateCookieName(SOURCE));
  if (!statesMatch(expected, url.searchParams.get('state'))) {
    return page(
      400,
      'Sign-in expired',
      '<p>The sign-in state did not match (expired or opened in another browser). <a href="/api/oauth/cnh">Start again</a>.</p>',
      { 'set-cookie': clearStateCookie(SOURCE, secure) },
    );
  }
  try {
    const tokens = await exchangeCnhCode(ep, code);
    const store = new OAuthTokenStore({
      pool: getPool(),
      source: SOURCE,
      org: cnhGrantOrg(ep),
      key: tokenKey(cfg.TOKEN_ENC_KEY),
    });
    await store.save(tokens);
  } catch (e) {
    console.error('[api/oauth/cnh]', (e as Error).message);
    return page(
      502,
      'CNH sign-in failed',
      `<p>${escapeHtml((e as Error).message)}</p><p><a href="/api/oauth/cnh">Try again</a></p>`,
      { 'set-cookie': clearStateCookie(SOURCE, secure) },
    );
  }
  return page(
    200,
    'Connected to CNH FieldOps',
    `<p>${sim ? 'Connected to the simulated FieldOps account.' : 'CNH FieldOps is connected.'} Machine positions sync on the next fleet.cnh run; a machine without an accepted EULA is listed on /admin/connectors.</p>
<p><a href="/admin/connectors">Connectors</a> · <a href="/board">Board</a></p>`,
    { 'set-cookie': clearStateCookie(SOURCE, secure) },
  );
}
