import { defineConfig, devices } from '@playwright/test';
import { getE2eSettings } from './src/config';

/**
 * End-to-end skeleton (plan §7). The e2e stage adds `webServer` (a production build under
 * `next start`) and the specs. Settings come from src/config.ts (never process.env here):
 * E2E_BASE_URL points the suite at an already-running app; without it the suite uses PUBLIC_URL
 * (parallel agents set theirs to 3101-3104 in .env.development.local), else localhost:3000.
 */
const { baseURL, ci } = getE2eSettings();

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
