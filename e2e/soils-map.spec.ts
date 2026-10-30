/**
 * The soil type map (soil map Phase A) on the wall (/board) and the phone (/m):
 *
 *  - colour-by modes switched from the rail, painted with setPaintProperty (no tile refetch),
 *    each with its own legend, remembered on this device across a reload;
 *  - the map units in view listed under the legend;
 *  - map unit labels from GET /api/soils/labels: one point per polygon, drawn from zoom 13;
 *  - with soils on, a tap outside any field opens the map unit sheet (components with %, the
 *    official series link, online only), while a field tap still opens the field panel; the
 *    field Soils tab opens the sheet for one of its map units.
 *
 * Data: the soils the database has (the synthetic fixture on a fresh database, loaded here the
 * way e2e/soils.spec.ts does). Assertions go through window.__map / window.__soils, not pixels.
 */
import path from 'node:path';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { assertLocalUrl } from '../src/db/admin';
import { createPool } from '../src/db/client';
import type { SoilLabelsResponse } from '../src/ui/map/layers/soils-labels';
import { RAIL_STORAGE_PREFIX } from '../src/ui/map/rail/persist';
import { loadSoilsRun } from '../tools/gis/soils-load';
import { openRun } from '../tools/gis/soils-raw';
import { signInAs } from './support/auth';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

interface Spot {
  lng: number;
  lat: number;
}
interface EmptySpot extends Spot {
  mukey: string;
  musym: string;
  components: number;
}
interface FieldSpot extends Spot {
  id: string;
  name: string;
}

let pool: Pool;
/** Points inside a soil polygon, well away from every field (candidates for an empty tap). */
let empties: EmptySpot[] = [];
/** Points inside fields that have soils. */
let fields: FieldSpot[] = [];

test.beforeAll(async () => {
  const url = getConfig().DATABASE_URL;
  pool = createPool({ connectionString: url, max: 2 });
  const loaded = await pool.query<{ built: Date | null }>(
    `select built_at as built from gis.map_layers where key = 'soils'`,
  );
  if (!loaded.rows[0]?.built) {
    assertLocalUrl(url, 'e2e soils fixture');
    await loadSoilsRun(pool, await openRun(path.join('tools', 'gis', 'fixtures', 'soils')));
  }
  const e = await pool.query<EmptySpot>(
    `select sp.mukey, u.musym, jsonb_array_length(u.components)::int as components,
            extensions.ST_X(c.p) as lng, extensions.ST_Y(c.p) as lat
       from gis.soil_polygons sp
       join gis.soil_mapunits u on u.mukey = sp.mukey
      cross join lateral (
        select (extensions.ST_MaximumInscribedCircle(sp.geom)).center as p) c
      where u.musym is not null and jsonb_array_length(u.components) > 0
        and not exists (
          select 1 from farm.current_boundaries b
           where extensions.ST_DWithin(b.geom, c.p, 0.004))
      order by extensions.ST_Area(sp.geom) desc
      limit 12`,
  );
  empties = e.rows;
  const f = await pool.query<FieldSpot>(
    `select f.id::text as id, f.name,
            extensions.ST_X(extensions.ST_PointOnSurface(b.geom)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(b.geom)) as lat
       from farm.current_boundaries b
       join farm.fields f on f.id = b.field_id and f.active
      where exists (select 1 from gis.field_soils fs where fs.boundary_id = b.id)
      order by f.name`,
  );
  fields = f.rows;
});

test.afterAll(async () => {
  await pool?.end();
});

test.beforeEach(async ({ context }) => {
  await signInAs(context);
});

/** Of `spots`, the one farthest from every machine (a tap there hits no combine or truck). */
async function quietest<T extends Spot>(page: Page, spots: T[]): Promise<T> {
  const machines = await page.evaluate(() =>
    (window.__map?.fleet() ?? []).map((m) => [m.lng, m.lat] as [number, number]),
  );
  let best: T | null = null;
  let bestD = -1;
  for (const s of spots) {
    const d = Math.min(
      Number.POSITIVE_INFINITY,
      ...machines.map(([x, y]) => Math.hypot((x - s.lng) * 0.75, y - s.lat)),
    );
    if (d > bestD) {
      best = s;
      bestD = d;
    }
  }
  if (!best) throw new Error('no candidate spot');
  return best;
}

async function openBoard(page: Page, testInfo: TestInfo) {
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
}

async function jumpTo(page: Page, s: Spot, zoom: number) {
  await page.evaluate(({ c, z }) => window.__map?.jumpTo({ center: c, zoom: z, bearing: 0 }), {
    c: [s.lng, s.lat] as [number, number],
    z: zoom,
  });
  await mapIdle(page);
}

async function openRail(page: Page) {
  const rail = page.getByTestId('layer-rail');
  if (!(await rail.isVisible())) await page.getByTestId('layer-rail-toggle').click();
  await expect(rail).toBeVisible();
}

/** Phones: the open rail covers most of the map; close it before tapping the map. */
async function clearMap(page: Page, testInfo: { project: { name: string } }) {
  if (testInfo.project.name !== 'phone') return;
  const rail = page.getByTestId('layer-rail');
  if (await rail.isVisible()) {
    await rail.getByTestId('layer-rail-toggle').click();
    await expect(rail).toHaveCount(0);
  }
}

async function soilsOn(page: Page) {
  await openRail(page);
  const toggle = page.getByTestId('layer-toggle-soils');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

const rendered = (page: Page, layer: string) =>
  page.evaluate((l) => window.__map?.queryRenderedFeatures({ layers: [l] }) ?? [], layer);

const paint = (page: Page, layer: string, name: string) =>
  page.evaluate(({ l, n }) => window.__soils?.paint(l, n) ?? null, { l: layer, n: name });

/**
 * Bring `s` into view at z15 where a tap can reach it: on phones a bottom sheet (the field panel
 * or the map unit sheet) covers the middle of the screen, so the point goes into the upper part.
 */
async function jumpAbovePhoneSheet(page: Page, testInfo: TestInfo, s: Spot) {
  const phone = testInfo.project.name === 'phone';
  await jumpTo(page, { lng: s.lng, lat: phone ? s.lat - 0.0025 : s.lat }, 15);
}

/** Wait until the map stops moving (the field panel eases a tapped field into view). */
async function settle(page: Page) {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await page.evaluate(() => window.__map?.center()));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [300], timeout: 10_000 },
    )
    .toBe(true);
}

/** Wait until the soils drawn at a point are the map unit `mukey` (tiles loaded there). */
async function soilsDrawnAt(page: Page, s: Spot, mukey: string) {
  await expect
    .poll(() => page.evaluate((c) => window.__soils?.unitAt(c.lng, c.lat)?.mukey ?? null, s), {
      timeout: 20_000,
    })
    .toBe(mukey);
}

/** Tap the map at a WGS84 point (as a finger would). */
async function tapAt(page: Page, s: Spot) {
  const p = await page.evaluate((c) => window.__map?.project(c[0], c[1]), [s.lng, s.lat] as [
    number,
    number,
  ]);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
}

/** One characteristic legend line per mode. */
const LEGEND_TEXT = {
  type: 'Map unit boundary',
  drainage: 'Very poorly drained',
  hydgrp: 'D: high runoff potential',
  farmland: 'Prime farmland if drained',
  nccpi: '0.60 to 0.75',
} as const;

test('colour-by modes from the rail: legends per mode, paint only, remembered across a reload', async ({
  page,
}, testInfo) => {
  // Two map loads at wall resolution under software WebGL.
  test.slow();
  const tiles: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/tiles/soils/')) tiles.push(r.url());
  });
  await openBoard(page, testInfo);
  const field = await quietest(page, fields);
  await jumpTo(page, field, 13.5);
  await soilsOn(page);

  // Default: today's drainage view.
  const modes = page.getByTestId('layer-modes-soils');
  await expect(modes).toBeVisible();
  await expect(page.getByTestId('layer-mode-soils-drainage')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const legend = page.getByTestId('layer-legend-soils');
  await expect(legend).toHaveAttribute('data-mode', 'drainage');
  await expect(legend).toContainText(LEGEND_TEXT.drainage);
  await expect
    .poll(async () => (await rendered(page, 'layer:soils:fill')).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  await mapIdle(page);
  const drainageColor = await paint(page, 'layer:soils:fill', 'fill-color');
  expect(JSON.stringify(drainageColor)).toContain('drainage_class');
  // Touch targets: 72 px on the wall, 52 px on phones (the rail's own sizes).
  const min = testInfo.project.name === 'phone' ? 52 : 72;
  const box = await page.getByTestId('layer-mode-soils-hydgrp').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(min - 0.5);

  // Every mode: its button pressed, its legend, its paint; tiles are never fetched again.
  const fetched = tiles.length;
  expect(fetched).toBeGreaterThan(0);
  for (const mode of ['type', 'hydgrp', 'farmland', 'nccpi', 'drainage'] as const) {
    await page.getByTestId(`layer-mode-soils-${mode}`).click();
    await expect(page.getByTestId(`layer-mode-soils-${mode}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(legend).toHaveAttribute('data-mode', mode);
    await expect(legend).toContainText(LEGEND_TEXT[mode]);
    const opacity = await paint(page, 'layer:soils:fill', 'fill-opacity');
    if (mode === 'type') {
      // No fill, but the (transparent) fill still finds the map unit under a tap.
      expect(opacity).toBe(0);
      await expect
        .poll(async () => (await rendered(page, 'layer:soils:fill')).length)
        .toBeGreaterThan(0);
    } else {
      expect(opacity).toBeGreaterThan(0);
      const color = JSON.stringify(await paint(page, 'layer:soils:fill', 'fill-color'));
      const prop = {
        hydgrp: 'hydgrp',
        farmland: 'farmland_class',
        nccpi: 'nccpi',
        drainage: 'drainage_class',
      }[mode];
      expect(color, mode).toContain(prop);
    }
  }
  await mapIdle(page);
  expect(tiles.length, 'mode switches fetch no tiles').toBe(fetched);

  // The map units in view, under the legend, match what is drawn.
  const inView = page.getByTestId('soils-in-view');
  await expect(inView).toBeVisible();
  const drawn = new Set(
    (await rendered(page, 'layer:soils:fill')).map((f) => String(f.properties.mukey)),
  );
  const listed = await page
    .getByTestId('soils-in-view-row')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.mukey ?? ''));
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.every((m) => drawn.has(m))).toBe(true);
  await expect(inView).toContainText(/dominant component/);

  // Remembered on this device: Hydrologic group survives a reload.
  await page.getByTestId('layer-mode-soils-hydgrp').click();
  await expect
    .poll(() =>
      page.evaluate((prefix) => {
        const k = Object.keys(localStorage).find((x) => x.startsWith(prefix));
        return k ? JSON.parse(localStorage.getItem(k) ?? '{}').modes : null;
      }, RAIL_STORAGE_PREFIX),
    )
    .toEqual({ soils: 'hydgrp' });
  await page.reload();
  await waitForMap(page);
  await jumpTo(page, field, 13.5);
  await openRail(page);
  await expect(page.getByTestId('layer-toggle-soils')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-mode-soils-hydgrp')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-legend-soils')).toHaveAttribute('data-mode', 'hydgrp');
  await expect
    .poll(async () => JSON.stringify(await paint(page, 'layer:soils:fill', 'fill-color')), {
      timeout: 20_000,
    })
    .toContain('hydgrp');

  // "Defaults" puts the mode back too.
  await page.getByTestId('layer-rail-reset').click();
  await expect(page.getByTestId('layer-toggle-soils')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('layer-toggle-soils').click();
  await expect(page.getByTestId('layer-mode-soils-drainage')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => window.__map?.errors())).toEqual([]);
});

test('map unit labels: one per polygon, from zoom 13', async ({ page }, testInfo) => {
  const answers: SoilLabelsResponse[] = [];
  const asked: string[] = [];
  page.on('response', async (r) => {
    if (!new URL(r.url()).pathname.startsWith('/api/soils/labels')) return;
    asked.push(r.url());
    if (r.ok()) answers.push((await r.json()) as SoilLabelsResponse);
  });
  await openBoard(page, testInfo);
  const field = await quietest(page, fields);
  await jumpTo(page, field, 12.4);
  await soilsOn(page);
  await expect
    .poll(async () => (await rendered(page, 'layer:soils:fill')).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  // Below zoom 13: polygons, no labels, and nothing asked.
  await page.waitForTimeout(600);
  expect(asked).toEqual([]);
  expect(await rendered(page, 'layer:soils:label')).toEqual([]);

  await jumpTo(page, field, 14);
  await expect.poll(() => answers.length, { timeout: 20_000 }).toBeGreaterThan(0);
  const answer = answers[answers.length - 1] as SoilLabelsResponse;
  expect(answer.features.length).toBeGreaterThan(0);
  const ids = answer.features.map((f) => f.id);
  expect(new Set(ids).size, 'one point per polygon').toBe(ids.length);
  expect(new URL(asked[asked.length - 1] ?? '').searchParams.get('z')).toBe('14');
  // Drawn: each placed label is a different polygon's (no repeats across tile seams).
  await expect
    .poll(async () => (await rendered(page, 'layer:soils:label')).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  const labels = await rendered(page, 'layer:soils:label');
  const ranks = labels.map((l) => l.properties.rank);
  expect(new Set(ranks).size).toBe(ranks.length);
  expect(labels.every((l) => typeof l.properties.musym === 'string')).toBe(true);
  // Labels draw above the field fills, just under the field names.
  const order = (await page.evaluate(() => window.__soils?.order() ?? [])) as string[];
  expect(order.indexOf('layer:soils:label')).toBeGreaterThan(order.indexOf('fields-fill'));
  expect(order.indexOf('layer:soils:fill')).toBeLessThan(order.indexOf('fields-fill'));

  // A small pan stays inside the last answer: nothing more is asked.
  const before = asked.length;
  const nudged = { lng: field.lng + 0.002, lat: field.lat };
  await jumpTo(page, nudged, 14);
  await page.waitForTimeout(600);
  expect(asked.length).toBe(before);

  // Soils off: the labels go with them.
  await page.getByTestId('layer-toggle-soils').click();
  await expect.poll(async () => (await rendered(page, 'layer:soils:label')).length).toBe(0);
  expect(await page.evaluate(() => window.__map?.errors())).toEqual([]);
});

test('with soils on, a tap outside the fields opens the map unit; a field tap still opens the field', async ({
  page,
  context,
}, testInfo) => {
  test.slow();
  await openBoard(page, testInfo);
  const spot = await quietest(page, empties);
  await jumpTo(page, spot, 15);

  // Soils off: an empty tap opens nothing.
  await tapAt(page, spot);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('map-unit-sheet')).toHaveCount(0);

  await soilsOn(page);
  await clearMap(page, testInfo);
  await expect
    .poll(async () => (await rendered(page, 'layer:soils:fill')).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  await mapIdle(page);
  await tapAt(page, spot);
  const sheet = page.getByTestId('map-unit-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mukey', spot.mukey);
  await expect(page.getByTestId('map-unit-title')).toContainText(spot.musym);
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
  // The facts at once, then the components with their percentages.
  for (const k of ['drainage', 'hydgrp', 'farmland', 'nccpi']) {
    await expect(page.getByTestId(`map-unit-fact-${k}`)).toBeVisible();
  }
  await expect(sheet).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('map-unit-component')).toHaveCount(spot.components);
  await expect(page.getByTestId('map-unit-component').first()).toContainText(/\d %/);
  await expect(sheet).toContainText(/dominant component/);
  // The official series description, online only.
  const link = page.getByTestId('map-unit-osd-link').first();
  await expect(link).toHaveAttribute(
    'href',
    /^https:\/\/soilseries\.sc\.egov\.usda\.gov\/OSD_Docs\/[A-Z]\/[A-Z_]+\.html$/,
  );
  await expect(link).toHaveAttribute('target', '_blank');
  await context.setOffline(true);
  try {
    await expect(page.getByTestId('map-unit-osd-offline')).toBeVisible();
    await expect(page.getByTestId('map-unit-osd-link')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId('map-unit-osd-link').first()).toBeVisible();
  // The map unit's polygons are outlined while the sheet is open.
  await expect
    .poll(async () => (await rendered(page, 'layer:soils:selected')).map((f) => f.properties.mukey))
    .toContain(spot.mukey);

  // A field tap still wins: the field panel opens, the sheet closes. (Phones: the sheet covers
  // the middle of the screen, so the tap goes above it.)
  const field = await quietest(page, fields);
  await jumpAbovePhoneSheet(page, testInfo, field);
  await tapAt(page, field);
  await expect(page.getByTestId('field-panel')).toBeVisible();
  await expect(page.getByTestId('field-panel')).toHaveAttribute('data-field-id', field.id);
  await expect(page.getByTestId('map-unit-sheet')).toHaveCount(0);
  await expect.poll(async () => (await rendered(page, 'layer:soils:selected')).length).toBe(0);

  // And an empty tap closes the field panel and opens the map unit again.
  await settle(page);
  await jumpAbovePhoneSheet(page, testInfo, spot);
  await soilsDrawnAt(page, spot, spot.mukey);
  await tapAt(page, spot);
  await expect(page.getByTestId('map-unit-sheet')).toBeVisible();
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
  await page.getByTestId('map-unit-close').click();
  await expect(page.getByTestId('map-unit-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => window.__map?.errors())).toEqual([]);
});

test('the field Soils tab opens a map unit’s sheet over the field', async ({ page }, testInfo) => {
  await openBoard(page, testInfo);
  const field = await quietest(page, fields);
  await jumpTo(page, field, 15);
  await tapAt(page, field);
  await expect(page.getByTestId('field-panel')).toBeVisible();
  await page.getByTestId('field-tab-soils').click();
  const first = page.getByTestId('field-soils-row').first();
  const mukey = await first.getAttribute('data-mukey');
  await first.getByTestId('field-soils-open-mapunit').click();
  const sheet = page.getByTestId('map-unit-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mukey', mukey ?? '');
  await expect(sheet).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('map-unit-component').first()).toBeVisible();
  // Closing the sheet returns to the field.
  await page.getByTestId('map-unit-close').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('field-panel')).toBeVisible();
});
