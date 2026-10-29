/**
 * /admin/* is locked until the admin link `pnpm dev` prints has set the admin cookie in that
 * browser (src/platform/auth/admin-key.ts): a phone on the shop Wi-Fi can open /board and /m but
 * not pause the job clock or inject faults. Read-only; runs once (wall project).
 */
import { expect, test } from '@playwright/test';
import { unlockUrl } from './support/admin';

test('admin pages are locked without the admin cookie; the printed link unlocks them', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'one browser is enough');
  for (const path of ['/admin/connectors', '/admin/realtime']) {
    await page.goto(path);
    await expect(page.getByTestId('admin-locked')).toBeVisible();
  }
  await expect(page.getByTestId('clock-toggle')).toHaveCount(0);

  const wrong = await page.goto('/admin/unlock?key=wrong');
  expect(wrong?.status()).toBe(403);
  await page.goto('/admin/connectors');
  await expect(page.getByTestId('admin-locked')).toBeVisible();

  const res = await page.goto(unlockUrl());
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('clock-toggle')).toBeVisible(); // meta refresh to /admin/connectors
  await expect(page.getByTestId('admin-locked')).toHaveCount(0);
});
