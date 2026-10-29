/**
 * The board loads with the internet gone: every non-local host is blocked (route abort), the
 * basemap is the local PMTiles extract, and its labels render with the local fonts. Runs as
 * /board in the `wall` project and /m in the `phone` project.
 *
 * Without an installed basemap (CI, a fresh clone) the board must still render fields and show
 * the "basemap missing" badge, and the label checks are skipped with a pointer to
 * `pnpm gis:basemap` (contracts §10).
 */
import { expect, type Response, test } from '@playwright/test';
import { blockExternalHosts, mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** Place-label layers of the pinned @protomaps/basemaps style. */
const PLACE_LABEL_LAYERS = [
  'places_locality',
  'places_subplace',
  'places_region',
  'places_country',
];
const ROAD_LABEL_LAYERS = ['roads_labels_major', 'roads_labels_minor'];

async function basemapInstalled(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get('/api/storage/tiles/basemap.json');
  return res.ok() ? ((await res.json()) as { key: string; build: string }) : null;
}

test('the board loads with every non-local host blocked', async ({ page, baseURL }, testInfo) => {
  const blocked = await blockExternalHosts(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  await mapIdle(page);

  await expect(page.getByTestId('status-strip')).toBeVisible();
  await expect(page.getByTestId('war-room-map')).toBeVisible();
  expect(blocked, 'requests to non-local hosts').toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => window.__map?.errors())).toEqual([]);
  // The style never references another host.
  const layerIds = await page.evaluate(() => window.__map?.layerIds() ?? []);
  expect(layerIds).toEqual(expect.arrayContaining(['fields-fill', 'fields-outline']));
});

test('the basemap renders labels from local fonts', async ({
  page,
  baseURL,
  request,
}, testInfo) => {
  const manifest = await basemapInstalled(request);
  const blocked = await blockExternalHosts(page, baseURL);
  const glyphs: Response[] = [];
  const sprites: Response[] = [];
  const archive: Response[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/storage/tiles/assets/fonts/')) glyphs.push(r);
    if (u.pathname.startsWith('/api/storage/tiles/assets/sprites/')) sprites.push(r);
    if (/^\/api\/storage\/tiles\/basemap\.[0-9a-f]{8}\.pmtiles$/.test(u.pathname)) archive.push(r);
  });
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);

  if (!manifest) {
    await expect(page.getByTestId('badge-basemap-missing')).toBeVisible();
    test.skip(
      true,
      'no offline basemap installed (run `pnpm gis:basemap`); checked the badge instead',
    );
    return;
  }

  // Adrian at a zoom where towns and road names are labelled.
  await page.evaluate(() =>
    window.__map?.jumpTo({ center: [-84.0372, 41.8975], zoom: 11.5, bearing: 0 }),
  );
  await mapIdle(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          (layers) =>
            window.__map
              ?.queryRenderedFeatures({ layers })
              .map((f) => String(f.properties.name ?? f.properties['name:en'] ?? '')) ?? [],
          [...PLACE_LABEL_LAYERS, ...ROAD_LABEL_LAYERS].filter(Boolean),
        ),
      { timeout: 20_000, message: 'basemap label features rendered' },
    )
    .toContain('Adrian');

  expect(blocked).toEqual([]);
  expect(glyphs.length, 'glyph requests').toBeGreaterThan(0);
  for (const r of glyphs) {
    expect(r.status(), r.url()).toBe(200);
    expect(r.headers()['content-type']).toBe('application/x-protobuf');
  }
  expect(sprites.length, 'sprite requests').toBeGreaterThan(0);
  for (const r of sprites) expect(r.status(), r.url()).toBe(200);
  // PMTiles reads the archive with HTTP range requests.
  expect(archive.length).toBeGreaterThan(0);
  for (const r of archive) expect(r.status()).toBe(206);
  if (manifest.build.startsWith('local:synthetic')) {
    await expect(page.getByTestId('badge-basemap-synthetic')).toBeVisible();
  } else {
    await expect(page.getByTestId('badge-basemap-synthetic')).toHaveCount(0);
  }
  await expect(page.getByTestId('badge-basemap-missing')).toHaveCount(0);
});

test('kiosk: the page itself never scrolls, zooms or selects text', async ({ page }, testInfo) => {
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  const viewport = await page.evaluate(
    () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
  );
  expect(viewport).toContain('user-scalable=no');
  expect(viewport).toContain('maximum-scale=1');
  const screen = page.getByTestId(testInfo.project.name === 'phone' ? 'phone-board' : 'board');
  const styles = await screen.evaluate((el) => {
    const s = getComputedStyle(el);
    return { userSelect: s.userSelect, touchAction: s.touchAction, position: s.position };
  });
  expect(styles).toEqual({ userSelect: 'none', touchAction: 'none', position: 'fixed' });
  const scroll = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth - window.innerWidth,
    h: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(scroll.w).toBeLessThanOrEqual(0);
  expect(scroll.h).toBeLessThanOrEqual(0);
});

test('map controls are big enough to hit on a touch screen', async ({ page }, testInfo) => {
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  const min = testInfo.project.name === 'phone' ? 48 : 72;
  for (const name of ['Zoom in', 'Zoom out', 'Reset north', 'Show all fields']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box?.width, name).toBeGreaterThanOrEqual(min);
    expect(box?.height, name).toBeGreaterThanOrEqual(min);
  }
  const before = await page.evaluate(() => window.__map?.zoom() ?? 0);
  await page.getByRole('button', { name: 'Zoom in' }).tap();
  await expect
    .poll(() => page.evaluate(() => window.__map?.zoom() ?? 0))
    .toBeGreaterThan(before + 0.5);
});
