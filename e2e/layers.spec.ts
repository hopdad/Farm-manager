/**
 * The layer rail (plan 1d "layer toggles down one side"), on the wall (/board) and the phone
 * (/m): groups in rail order with touch-sized toggles, toggles that really show and hide map
 * layers, choices remembered per device across a reload, and an offline browser told so while
 * local layers keep working. Assertions go through window.__map (plan §7), not pixels.
 * The soils layer itself (tiles, legend, zoom hint) and the Soils tab: e2e/soils.spec.ts.
 */
import { expect, type Page, test } from '@playwright/test';
import { RAIL_STORAGE_PREFIX } from '../src/ui/map/rail/persist';
import { signInAs } from './support/auth';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** Over the demo farm (Adrian–Blissfield), zoomed in enough for every vector layer. */
const FARM_VIEW = { center: [-83.95, 41.9] as [number, number], zoom: 11 };

test.beforeEach(async ({ context }) => {
  await signInAs(context);
});

async function openBoard(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForMap(page);
  await page.evaluate((v) => window.__map?.jumpTo(v), FARM_VIEW);
  await mapIdle(page);
}

/** Open the rail (closed by default on phones). */
async function openRail(page: Page): Promise<void> {
  const rail = page.getByTestId('layer-rail');
  if (!(await rail.isVisible())) await page.getByTestId('layer-rail-toggle').click();
  await expect(rail).toBeVisible();
}

const rendered = (page: Page, layer: string) =>
  page.evaluate((l) => window.__map?.queryRenderedFeatures({ layers: [l] }).length ?? 0, layer);

test('the rail lists every group in rail order with touch-sized toggles', async ({
  page,
}, testInfo) => {
  await openBoard(page, mapPathFor(testInfo));
  if (testInfo.project.name === 'phone') {
    // Phones start with the rail closed; the wall shows it.
    await expect(page.getByTestId('layer-rail')).toHaveCount(0);
  } else {
    await expect(page.getByTestId('layer-rail')).toBeVisible();
  }
  await openRail(page);
  const groups = await page
    .locator('[data-testid^="layer-group-"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid));
  expect(groups).toEqual([
    'layer-group-fields',
    'layer-group-soils',
    'layer-group-terrain',
    'layer-group-imagery',
    'layer-group-tile',
    'layer-group-parcels',
    'layer-group-fleet',
    'layer-group-customers',
  ]);
  await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-toggle-fleet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-toggle-customers')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('layer-toggle-soils')).toBeEnabled();
  // A group whose layers arrive with another slice says what will fill it.
  await expect(page.getByTestId('layer-group-terrain')).toContainText('pnpm gis:dem');
  // 72 px targets on the wall, 52 px on phones.
  const min = testInfo.project.name === 'phone' ? 52 : 72;
  for (const key of ['fields', 'soils', 'fleet', 'customers']) {
    const box = await page.getByTestId(`layer-toggle-${key}`).boundingBox();
    expect(box?.height ?? 0, key).toBeGreaterThanOrEqual(min - 0.5);
  }
});

test('a toggle shows and hides its layer on the map', async ({ page }, testInfo) => {
  await openBoard(page, mapPathFor(testInfo));
  await openRail(page);
  await expect.poll(() => rendered(page, 'fields-fill'), { timeout: 20_000 }).toBeGreaterThan(0);

  const fields = page.getByTestId('layer-toggle-fields');
  await fields.click();
  await expect(fields).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => rendered(page, 'fields-fill')).toBe(0);
  await fields.click();
  await expect(fields).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => rendered(page, 'fields-fill')).toBeGreaterThan(0);

  // Custom-work customers: a layer the rail adds to the map (over the fields tiles).
  const customers = page.getByTestId('layer-toggle-customers');
  await customers.click();
  await expect(customers).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => page.evaluate(() => window.__map?.layerIds() ?? []))
    .toEqual(expect.arrayContaining(['layer:customers:outline']));
  await expect(page.getByTestId('layer-legend-customers')).toBeVisible();
  await customers.click();
  await expect(page.getByTestId('layer-legend-customers')).toHaveCount(0);
  expect(await page.evaluate(() => window.__map?.errors())).toEqual([]);
});

test('choices and the open rail are remembered on this device', async ({ page }, testInfo) => {
  // Three map loads (two reloads) at wall resolution under software WebGL.
  test.slow();
  await openBoard(page, mapPathFor(testInfo));
  await openRail(page);
  await page.getByTestId('layer-toggle-customers').click();
  await page.getByTestId('layer-toggle-fields').click();
  await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'false');
  const saved = await page.evaluate(
    (prefix) =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => [k, localStorage.getItem(k)]),
    RAIL_STORAGE_PREFIX,
  );
  expect(saved).toHaveLength(1);

  await page.reload();
  await waitForMap(page);
  await expect(page.getByTestId('layer-rail')).toBeVisible();
  await expect(page.getByTestId('layer-toggle-customers')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => rendered(page, 'fields-fill')).toBe(0);

  // Back to the defaults (and that is remembered too).
  await page.getByTestId('layer-rail-reset').click();
  await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-toggle-customers')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('layer-rail-toggle').click();
  await expect(page.getByTestId('layer-rail')).toHaveCount(0);
  await page.reload();
  await waitForMap(page);
  await expect(page.getByTestId('layer-rail')).toHaveCount(0);
  await openRail(page);
  await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'true');
});

test('offline: the rail says so and local layers keep working', async ({
  page,
  context,
}, testInfo) => {
  await openBoard(page, mapPathFor(testInfo));
  await openRail(page);
  await expect(page.getByTestId('layer-rail-offline')).toHaveCount(0);
  await context.setOffline(true);
  try {
    await expect(page.getByTestId('layer-rail-offline')).toBeVisible();
    // Already-loaded local layers still toggle.
    const fields = page.getByTestId('layer-toggle-fields');
    await fields.click();
    await expect(fields).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => rendered(page, 'fields-fill')).toBe(0);
    await fields.click();
    await expect.poll(() => rendered(page, 'fields-fill')).toBeGreaterThan(0);
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId('layer-rail-offline')).toHaveCount(0);
});
