/**
 * The job clock toggle on /admin/connectors (touch): pausing writes app.settings and publishes
 * admin/clock, which another browser context sees within 2 s; resuming restores it.
 * Runs once (wall project): it changes shared state.
 */
import { expect, test } from '@playwright/test';
import { unlockAdmin } from './support/admin';

test.describe.configure({ mode: 'serial' });

test('pausing the job clock reaches another context within 2 s', async ({ browser }, info) => {
  test.skip(info.project.name !== 'wall', 'toggles shared state: run it once');
  const admin = await browser.newContext({ hasTouch: true });
  const watcher = await browser.newContext();
  await unlockAdmin(admin);
  await unlockAdmin(watcher);
  try {
    const page = await admin.newPage();
    const monitor = await watcher.newPage();
    await monitor.goto('/admin/realtime?topics=admin');
    await expect(monitor.getByTestId('rt-state')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await page.goto('/admin/connectors');
    const toggle = page.getByTestId('clock-toggle');
    await expect(toggle).toBeVisible();

    // Start from "running" whatever an earlier run left behind.
    if ((await toggle.textContent())?.includes('Resume')) {
      await toggle.tap();
      await expect(toggle).toHaveText('Pause job clock', { timeout: 10_000 });
    }

    const sent = Date.now();
    await toggle.tap();
    const paused = monitor.locator('[data-testid="rt-event"][data-event="clock"]', {
      hasText: '"paused":true',
    });
    await expect(paused.first()).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - sent).toBeLessThan(2_000 + 1_000); // tap + server action round trip
    await expect(toggle).toHaveText('Resume job clock', { timeout: 10_000 });
    await expect(page.getByTestId('admin-notice')).toContainText('paused');

    await toggle.tap();
    await expect(toggle).toHaveText('Pause job clock', { timeout: 10_000 });
    await expect(
      monitor
        .locator('[data-testid="rt-event"][data-event="clock"]', { hasText: '"paused":false' })
        .first(),
    ).toBeVisible({ timeout: 2_000 });
  } finally {
    await admin.close();
    await watcher.close();
  }
});
