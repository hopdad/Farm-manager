import { defineConfig, devices } from '@playwright/test';
import { E2E_STORAGE_STATE } from './e2e/global-setup';
import { getE2eSettings } from './src/config';

/**
 * End-to-end tests (plan §7). Settings come from src/config.ts (never process.env here).
 *
 *  - Without E2E_BASE_URL the suite starts the whole stack itself with `pnpm pilot` (vendor
 *    stand-in, `next start -H 0.0.0.0` on PUBLIC_URL's port, the job clock) and waits for
 *    /api/health; CI builds first and passes --skip-build. Locally an app already answering on
 *    that port (`pnpm dev` or `pnpm pilot`) is reused.
 *  - With E2E_BASE_URL the suite tests that app as is (no webServer).
 *
 * MapLibre 6 needs WebGL2; headless Chromium in CI and containers only has SwiftShader, which
 * Chrome enables for WebGL only with these flags (plan §7 CI notes).
 */
const { baseURL, ci, external } = getE2eSettings();

const WEBGL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  // The specs share one app, one simulated farm and one database.
  workers: ci ? 2 : undefined,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  // Sessions (auth builder, contracts-m1 §4): every context starts as the enrolled e2e viewer
  // kiosk; specs sign in as other roles with signInAs (e2e/support/auth.ts).
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    storageState: E2E_STORAGE_STATE,
    trace: 'retain-on-failure',
    launchOptions: { args: WEBGL_ARGS },
  },
  webServer: external
    ? undefined
    : {
        command: ci ? 'pnpm pilot --skip-build' : 'pnpm pilot',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !ci,
        // next build (locally) + first boot of the stand-in and Next.
        timeout: 300_000,
        // tools/pilot.ts stops the stand-in, Next and the clock (whole trees) on SIGTERM.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
        stdout: 'ignore',
        stderr: 'pipe',
      },
  projects: [
    {
      // War-room wall: 1080p at DPR 2 (4K-equivalent), touch.
      name: 'wall',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
        hasTouch: true,
      },
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
