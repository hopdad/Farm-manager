/**
 * The /admin/unlock response (pure, unit-tested): with the right key, a page that sets the admin
 * cookie and links to /admin/connectors; never 3xx.
 */
import { escapeHtml, oauthPage } from '@/connectors/oauth/flow';
import { adminCookie, isAdminKey } from '@/platform/auth/admin-key';
import { limitedBytes } from '@/platform/http/limits';

const NEXT_PAGE = '/admin/connectors';

/** The response for a request URL under `cfg`. */
export function unlockResponse(
  cfg: { SESSION_SECRET: string; isProduction: boolean; cookieSecure: boolean },
  requestUrl: string,
): Response {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (cfg.isProduction) {
    return limitedBytes(oauthPage('Not found', '<p>No admin unlock in production.</p>'), {
      status: 404,
      headers,
    });
  }
  const key = new URL(requestUrl).searchParams.get('key');
  if (!isAdminKey(cfg, key)) {
    return limitedBytes(
      oauthPage(
        'Admin key not accepted',
        `<p>Open the Admin link that <code>pnpm dev</code> (or <code>pnpm pilot</code>) printed on the PC.</p>`,
      ),
      { status: 403, headers },
    );
  }
  return limitedBytes(
    oauthPage(
      'Admin unlocked',
      `<p>This browser can use the admin pages now.</p><p><a href="${escapeHtml(NEXT_PAGE)}">Connectors</a></p>`,
      NEXT_PAGE,
    ),
    {
      status: 200,
      headers: { ...headers, 'set-cookie': adminCookie(key as string, cfg.cookieSecure) },
    },
  );
}
