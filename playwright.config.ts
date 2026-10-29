import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end skeleton (plan §7). The e2e stage adds `webServer` (a production build under
 * `next start`) and the specs. E2E_BASE_URL points the suite at an already-running app
 * (parallel agents use ports 3101-3104).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
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
