/**
 * Touch gestures on the map (plan §7): pinch zoom, two-finger rotate and one-finger pan through
 * dispatched (isTrusted=false) touch events, asserted through window.__map.
 */
import { expect, test } from '@playwright/test';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';
import { pan, pinch, rotate } from './support/touch';

test.use({ launchOptions: { args: WEBGL_ARGS } });

const zoom = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__map?.zoom() ?? Number.NaN);

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  await page.evaluate(() => window.__map?.jumpTo({ center: [-83.9, 41.88], zoom: 11, bearing: 0 }));
  await mapIdle(page);
});

test('pinch out zooms in, pinch in zooms out', async ({ page }) => {
  const canvas = page.locator('.maplibregl-canvas');
  const z0 = await zoom(page);
  await pinch(canvas, 2.5);
  await expect.poll(() => zoom(page)).toBeGreaterThan(z0 + 0.5);
  await mapIdle(page);
  const z1 = await zoom(page);
  await pinch(canvas, 0.4, 260);
  await expect.poll(() => zoom(page)).toBeLessThan(z1 - 0.5);
});

test('two-finger twist rotates the map', async ({ page }) => {
  const canvas = page.locator('.maplibregl-canvas');
  expect(await page.evaluate(() => window.__map?.bearing())).toBe(0);
  await rotate(canvas, 40);
  await expect
    .poll(() => page.evaluate(() => Math.abs(window.__map?.bearing() ?? 0)))
    .toBeGreaterThan(10);
  // The compass button puts north back up.
  await page.getByRole('button', { name: 'Reset north' }).tap();
  await expect
    .poll(() => page.evaluate(() => Math.abs(window.__map?.bearing() ?? 1)))
    .toBeLessThan(0.01);
});

test('one-finger drag pans the map', async ({ page }) => {
  const canvas = page.locator('.maplibregl-canvas');
  const c0 = await page.evaluate(() => window.__map?.center());
  await pan(canvas, -200, 0);
  await expect
    .poll(async () => (await page.evaluate(() => window.__map?.center().lng ?? 0)) - (c0?.lng ?? 0))
    .toBeGreaterThan(0.01);
});
