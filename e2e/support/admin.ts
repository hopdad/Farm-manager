/**
 * The admin lock (src/platform/auth/admin-key.ts) in e2e: give a browser context the admin cookie
 * that /admin/unlock would set, computed from this checkout's SESSION_SECRET (the same env files
 * as the app under test; a remote E2E_BASE_URL must share the secret).
 */
import type { BrowserContext } from '@playwright/test';
import { getConfig, getE2eSettings } from '../../src/config';
import { ADMIN_COOKIE, adminKey, adminUnlockUrl } from '../../src/platform/auth/admin-key';

export async function unlockAdmin(
  context: BrowserContext,
  baseURL: string = getE2eSettings().baseURL,
): Promise<void> {
  await context.addCookies([
    {
      name: ADMIN_COOKIE,
      value: adminKey(getConfig().SESSION_SECRET),
      url: baseURL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

/** The link `pnpm dev` prints. */
export const unlockUrl = (baseURL: string = getE2eSettings().baseURL): string =>
  adminUnlockUrl(baseURL, getConfig().SESSION_SECRET);
