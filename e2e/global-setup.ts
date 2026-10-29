/**
 * Playwright global setup (docs/contracts-m1.md §4 "E2E"): every browser context of the suite
 * starts as the enrolled "E2E viewer kiosk" (a viewer wall device in the app's database), so
 * /board, /m, /api/fleet, /api/realtime and the private tiles keep working in the M0 specs with
 * real auth in force. Playwright 1.64 applies `use.storageState` to the page/context/request
 * fixtures and to `browser.newContext()` alike; a spec that needs a signed-out browser uses
 * `test.use({ storageState: { cookies: [], origins: [] } })`.
 *
 * Also removes the throwaway people and devices earlier runs of the auth specs left, and
 * returns the global teardown: after the run every e2e person is switched off and every e2e
 * device revoked (e2e/support/auth.ts retireE2ePrincipals), so on the PC's dev database nothing
 * the suite made can sign in between runs.
 * The file lives under .data/e2e/ (gitignored; not test-results/, which Playwright empties).
 * Works against E2E_BASE_URL too, when that app shares this checkout's SESSION_SECRET and
 * database (like unlockAdmin).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const E2E_STORAGE_STATE = path.join(
  import.meta.dirname,
  '..',
  '.data',
  'e2e',
  'storage-state.json',
);

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Imported here so playwright.config.ts can read E2E_STORAGE_STATE without loading pg.
  const { getE2eSettings } = await import('../src/config');
  const { AUTH_COOKIE, SESSION_TTL_SECONDS } = await import('../src/platform/auth/cookies');
  const { closeE2ePool, e2eIdentity, identityCookie, pruneE2eLeftovers, retireE2ePrincipals } =
    await import('./support/auth');
  const { baseURL } = getE2eSettings();
  try {
    await pruneE2eLeftovers();
    const identity = await e2eIdentity('viewer');
    const url = new URL(baseURL);
    const state = {
      cookies: [
        {
          name: AUTH_COOKIE,
          value: await identityCookie(identity),
          domain: url.hostname,
          path: '/',
          expires: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS.device,
          httpOnly: true,
          secure: url.protocol === 'https:',
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    };
    mkdirSync(path.dirname(E2E_STORAGE_STATE), { recursive: true });
    writeFileSync(E2E_STORAGE_STATE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    throw new Error(
      `e2e global setup could not create the viewer kiosk session in the app's database (${(e as Error).message}). Is the database up (pnpm db:up) and migrated (pnpm run bootstrap)?`,
    );
  } finally {
    await closeE2ePool();
  }
  return async () => {
    try {
      await retireE2ePrincipals();
    } finally {
      await closeE2ePool();
    }
  };
}
