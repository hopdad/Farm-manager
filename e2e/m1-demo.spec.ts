/**
 * The M1 "See it" demo (docs/build-plan.md §6, slices 1a-1d "Done when") on the composed board,
 * end to end against the real stack (pnpm pilot: the production build, the vendor stand-in, the
 * job clock, realtime). Nothing is mocked. Each slice's own specs go deeper (field-panel,
 * fleet-panel, auth, weather, field-data-*, soils, layers, imagery); this one walks the Friday
 * demo across them, on the board where every panel is mounted together:
 *
 *   1a  a phone on the LAN address signs in (name + PIN) and marks a combine down: the wall shows
 *       it within 2 s; tapping a field on the touch wall, with the live fleet, the rail, the
 *       fleet panel and the weather strip all on screen, opens its panel in under 200 ms
 *       (median of five). CONNECTOR_DEERE=replay: e2e/fleet-panel-replay.spec.ts, run against
 *       an app in replay mode (it skips itself in sim mode).
 *   1b  with every non-local host blocked, the weather strip renders from the simulated NWS and
 *       the spray layer, switched on from the rail, colours every field with its stored verdict
 *       and reasons (moving the wind slider: e2e/weather.spec.ts, which owns the stand-in's knobs)
 *   1c  `pnpm import:boundaries` and `pnpm import:seasons` (the CLIs Derrick runs) bring a test
 *       farm's fields onto the board; tapping one shows its soils, landlord and 5 seasons. The
 *       data:export -> db:reset -> re-sync -> data:import round trip: tools/import/
 *       data-transfer.db.test.ts (a reset can't run under a live app).
 *   1d  with every non-local host blocked: basemap, fields, soils, parcels (synthetic, D7), tile
 *       lines and the simulated fleet all draw; the online-only aerial photos say "offline".
 *
 * Runs once (wall project), one test at a time: each opens several software-WebGL maps.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { getConfig } from '../src/config';
import { runNode, tsxBin } from '../src/lib/proc';
import type { FleetPanelData } from '../src/ui/fleet/contract';
import type { SprayMapResponse } from '../src/ui/weather/contract';
import type {} from '../src/ui/weather/SprayFieldState';
import { e2eIdentity, e2ePin, e2ePool, e2eUserId, lanOrigin, signInAs } from './support/auth';
import { blockExternalHosts, mapIdle, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

/** Plan 1a: "Marking a combine down on your phone updates the wall within 2 s". */
const WALL_UPDATE_MS = 2_000;
/** Plan 1a: "tapping a field opens the panel in under 200 ms". */
const TAP_BUDGET_MS = 200;
const SIGNED_OUT = { cookies: [], origins: [] };

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'wall', 'the demo drives its own wall and phone');
});

async function wallContext(browser: Browser, role: 'viewer' | 'manager' = 'viewer') {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  await signInAs(ctx, role);
  return ctx;
}

async function openBoard(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/board');
  await waitForMap(page, 90_000);
  return page;
}

async function jumpTo(page: Page, center: [number, number], zoom: number): Promise<void> {
  await page.evaluate((v) => window.__map?.jumpTo({ ...v, bearing: 0 }), { center, zoom });
  await mapIdle(page);
}

/** Tap the map at a WGS84 point (trusted touch). */
async function tapAt(page: Page, lng: number, lat: number): Promise<void> {
  await mapIdle(page);
  const p = await page.evaluate((c) => window.__map?.project(c[0], c[1]), [lng, lat] as [
    number,
    number,
  ]);
  if (!p) throw new Error('map not ready');
  const box = await page.getByTestId('war-room-map').boundingBox();
  await page.touchscreen.tap((box?.x ?? 0) + p.x, (box?.y ?? 0) + p.y);
}

const rendered = (page: Page, layer: string) =>
  page.evaluate((l) => window.__map?.queryRenderedFeatures({ layers: [l] }).length ?? 0, layer);

/** Switch a layer on from the rail (open on the wall). */
async function railOn(page: Page, key: string): Promise<void> {
  const toggle = page.getByTestId(`layer-toggle-${key}`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

/** Demo fields: a point inside each current boundary (the app's own database). */
async function demoFieldPoints(n: number): Promise<{ id: string; lng: number; lat: number }[]> {
  const r = await e2ePool().query<{ id: string; lng: number; lat: number }>(
    `select f.id::text as id,
            extensions.ST_X(extensions.ST_PointOnSurface(b.geom)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(b.geom)) as lat
       from farm.fields f join farm.current_boundaries b on b.field_id = f.id
      where f.active and f.source = 'demo'
      order by f.name limit $1`,
    [n],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------------------------
// 1a
// ---------------------------------------------------------------------------------------------

test('1a: a phone on the LAN signs in, marks a combine down; the wall shows it within 2 s', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = lanOrigin(baseURL);
  test.skip(!origin, 'this machine has no LAN address');
  await e2eIdentity('manager'); // "E2E Manager" exists, is switched on and has a PIN
  const wallCtx = await wallContext(browser);
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], storageState: SIGNED_OUT });
  let downId: string | null = null;
  try {
    const wall = await openBoard(wallCtx);

    // The phone opens /m over the LAN address, is sent to sign in, and comes back.
    const phone = await phoneCtx.newPage();
    await phone.goto(`${origin}/m`);
    await expect(phone).toHaveURL(`${origin}/login?next=%2Fm`);
    await phone
      .locator(`[data-testid="pin-name"][data-person-id="${e2eUserId('manager')}"]`)
      .click();
    await phone.getByTestId('pin-input').fill(e2ePin('manager'));
    await phone.getByTestId('pin-submit').click();
    await expect(phone).toHaveURL(`${origin}/m`);
    await expect(phone.getByTestId('session-chip')).toContainText('E2E Manager');

    // A combine that is on the map and not down.
    let target: FleetPanelData['machines'][number] | undefined;
    await expect
      .poll(
        async () => {
          const res = await phone.request.get(`${origin}/api/machines`);
          const data = (await res.json()) as FleetPanelData;
          target = data.machines.find(
            (m) => m.kind === 'combine' && m.position !== null && m.status === 'active',
          );
          return target?.id ?? null;
        },
        { timeout: 60_000, message: 'a combine with a position (is the clock running?)' },
      )
      .not.toBeNull();
    const id = (target as NonNullable<typeof target>).id;
    const wallRow = wall.locator(`[data-testid="fleet-panel-row"][data-machine-id="${id}"]`);
    await expect(wallRow).toBeVisible({ timeout: 20_000 });
    const marker = () =>
      wall.evaluate((mid) => window.__map?.fleet().find((m) => m.id === mid)?.status ?? null, id);
    await expect.poll(marker, { timeout: 30_000 }).toBe('active');

    await phone.getByTestId('fleet-panel-toggle').tap();
    const phoneRow = phone.locator(`[data-testid="fleet-panel-row"][data-machine-id="${id}"]`);
    await phoneRow.getByTestId('fleet-mark-down').tap();
    const sheet = phone.getByTestId('fleet-status-sheet');
    await sheet.getByTestId('fleet-reason-breakdown').tap();
    // Warm the route over the LAN (a refused body changes nothing): a cold first compile of a
    // route is not the 2 s the crew waits for.
    expect(
      (await phone.request.post(`${origin}/api/machines/${id}/status`, { data: {} })).status(),
    ).toBe(400);
    await sheet.getByTestId('fleet-status-submit').tap();
    downId = id;
    const t0 = Date.now();
    await Promise.all([
      expect(wallRow).toHaveAttribute('data-group', 'down', { timeout: WALL_UPDATE_MS }),
      expect.poll(marker, { timeout: WALL_UPDATE_MS, intervals: [50] }).toBe('down'),
    ]);
    const took = Date.now() - t0;
    test.info().annotations.push({ type: 'phone → wall (ms)', description: String(took) });
    console.log(`[m1-demo] phone (LAN) → wall: ${took} ms`);
    expect(took).toBeLessThanOrEqual(WALL_UPDATE_MS + 300);
  } finally {
    if (downId) {
      await phoneCtx.request
        .post(`${origin}/api/machines/${downId}/status`, { data: { status: 'active' } })
        .catch(() => {});
    }
    await wallCtx.close();
    await phoneCtx.close();
  }
});

test.describe('1a: tap budget on the composed wall', () => {
  // A timing budget on a shared machine drawing WebGL in software: a load burst can stall one
  // sample set; a second set decides (as in e2e/field-panel.spec.ts).
  test.describe.configure({ retries: 2 });

  test('tapping a field opens its panel in under 200 ms with every panel on screen', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const ctx = await wallContext(browser);
    try {
      const page = await openBoard(ctx);
      await expect(page.getByTestId('layer-rail')).toBeVisible();
      await expect(page.getByTestId('weather-strip')).toBeVisible();
      await page.evaluate(() => {
        window.addEventListener(
          'touchstart',
          () => {
            (window as unknown as { __tapAt: number }).__tapAt = performance.now();
          },
          { capture: true },
        );
      });
      const fields = await demoFieldPoints(6);
      const timings: number[] = [];
      for (const [i, f] of fields.entries()) {
        await jumpTo(page, [f.lng, f.lat], 15);
        await tapAt(page, f.lng, f.lat);
        const panel = page.getByTestId('field-panel');
        await expect(panel).toHaveAttribute('data-field-id', f.id);
        await expect(panel).toHaveAttribute('data-state', 'ready');
        const ms = await page.evaluate((id) => {
          const ready = performance
            .getEntriesByName('field-panel:ready')
            .filter((m) => (m as PerformanceMark).detail?.fieldId === id)
            .at(-1)?.startTime;
          const at = (window as unknown as { __tapAt: number }).__tapAt;
          return ready === undefined ? Number.POSITIVE_INFINITY : ready - at;
        }, f.id);
        if (i > 0) timings.push(ms); // the first tap loads the route
        await page.getByTestId('field-panel-close').click();
        await expect(panel).toHaveCount(0);
      }
      const median = [...timings].sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
      const summary = timings.map((t) => t.toFixed(0)).join(', ');
      test.info().annotations.push({ type: 'tap → panel (ms)', description: summary });
      console.log(`[m1-demo] tap → panel ms on the composed wall: ${summary}`);
      expect(median, `median tap → panel; ${summary}`).toBeLessThan(TAP_BUDGET_MS);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 1b
// ---------------------------------------------------------------------------------------------

test('1b: offline, the strip renders and the spray layer colours fields with their verdicts', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const ctx = await wallContext(browser);
  try {
    // A forecast is stored (the clock runs weather.nws; run it now rather than wait).
    await expect
      .poll(
        async () => {
          await ctx.request
            .post('/api/jobs/weather.nws', {
              headers: { authorization: `Bearer ${getConfig().JOBS_SECRET}` },
            })
            .catch(() => {});
          const v = (await (
            await ctx.request.get('/api/weather/spray')
          ).json()) as SprayMapResponse;
          return v.fields.length;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBeGreaterThan(0);

    const page = await ctx.newPage();
    const blocked = await blockExternalHosts(page, baseURL);
    await page.goto('/board');
    await waitForMap(page, 90_000);
    const strip = page.getByTestId('weather-strip');
    await expect(strip).toHaveAttribute('data-state', 'ready');
    await expect(strip.getByTestId('weather-day').first()).toBeVisible();
    await expect(strip.getByText('Simulated weather')).toBeVisible();
    await expect(page.getByTestId('spray-toggle')).toContainText(/Advisory/);

    // The spray layer from the rail: drawn over the fields, coloured by feature state.
    await jumpTo(page, [-83.95, 41.9], 11);
    await railOn(page, 'spray');
    await expect
      .poll(() => rendered(page, 'layer:spray:fill'), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await page.waitForFunction(() => !!window.__spray, null, { timeout: 30_000 });
    const api = (await (await ctx.request.get('/api/weather/spray')).json()) as SprayMapResponse;
    const expected = Object.fromEntries(api.fields.map((f) => [f.fieldId, f.verdict]));
    await expect
      .poll(
        () =>
          page.evaluate((ids) => {
            const s = window.__spray;
            return s ? ids.map((id) => s.featureState(id)) : [];
          }, Object.keys(expected)),
        { timeout: 30_000 },
      )
      .toEqual(Object.values(expected));

    // Every field's verdict comes with its stored reasons (the audit trail).
    const one = api.fields[0]?.fieldId as string;
    const detail = await (await ctx.request.get(`/api/weather/spray/${one}`)).json();
    expect(Array.isArray(detail.hours[0].reasons)).toBe(true);
    expect(detail.hours[0].verdict).toBe(expected[one]);
    expect(blocked, 'requests to non-local hosts').toEqual([]);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------------------------
// 1c
// ---------------------------------------------------------------------------------------------

interface TestFarm {
  farm: string;
  names: [string, string];
  /** A point inside each field. */
  inside: [[number, number], [number, number]];
}

/**
 * Two touching ~20 ac fields on soil-covered ground no field is near (60 m clear), as a GeoJSON
 * export would bring them. (The synthetic soils fixture covers the demo fields and their
 * surroundings; a real SSURGO load covers both counties.)
 */
async function writeTestFarm(dir: string, key: string): Promise<TestFarm & { file: string }> {
  const r = await e2ePool().query<{ x: number; y: number }>(
    `with soils as (select extensions.ST_Union(geom) as g from gis.soil_polygons),
          taken as (
            select extensions.ST_Union(
                     extensions.ST_Buffer(geom::extensions.geography, 60)::extensions.geometry) as g
              from farm.current_boundaries),
          pts as (
            select (extensions.ST_Dump(extensions.ST_GeneratePoints(soils.g, 1000, 7))).geom as p
              from soils)
     select extensions.ST_X(p) as x, extensions.ST_Y(p) as y
       from pts, soils, taken
      where extensions.ST_CoveredBy(
              extensions.ST_Expand(p, 0.0025, 0.0019), soils.g)
        and (taken.g is null
             or not extensions.ST_Intersects(extensions.ST_Expand(p, 0.0025, 0.0019), taken.g))
      limit 1`,
  );
  const c = r.rows[0];
  if (!c) throw new Error('no free, soil-covered ground for the test farm');
  // ~20 ac each: 0.0024° wide (~200 m at 42°N) x 0.0036° tall (~400 m).
  const w = 0.0024;
  const h = 0.0036;
  const square = (x0: number) => [
    [
      [x0, c.y - h / 2],
      [x0 + w, c.y - h / 2],
      [x0 + w, c.y + h / 2],
      [x0, c.y + h / 2],
      [x0, c.y - h / 2],
    ],
  ];
  const farm: TestFarm = {
    farm: `E2E M1 farm ${key}`,
    names: [`E2E West ${key}`, `E2E East ${key}`],
    inside: [
      [c.x - w / 2, c.y],
      [c.x + w / 2, c.y],
    ],
  };
  const geojson = {
    type: 'FeatureCollection',
    features: farm.names.map((name, i) => ({
      type: 'Feature',
      properties: { FIELD_NAME: name, FARM_NAME: farm.farm },
      geometry: { type: 'Polygon', coordinates: square(i === 0 ? c.x - w : c.x) },
    })),
  };
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `boundaries-${key}.geojson`);
  await writeFile(file, JSON.stringify(geojson));
  return { ...farm, file };
}

async function cli(entry: string, args: string[]): Promise<string> {
  const res = await runNode(tsxBin(), [entry, ...args], { timeoutMs: 120_000 });
  const out = `${res.stdout}\n${res.stderr}`;
  expect(res.code, `${entry} ${args.join(' ')}\n${out}`).toBe(0);
  return out;
}

test('1c: imported boundaries and seasons reach the board; a tap shows soils, landlord, 5 seasons', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const key = Date.now().toString(36);
  const dir = test.info().outputPath('m1-import');
  const farm = await writeTestFarm(dir, key);
  const pool = e2ePool();
  const ctx = await wallContext(browser);
  try {
    // pnpm import:boundaries <file> --farm "..." --county 26091
    await cli(path.join('scripts', 'import-boundaries.ts'), [
      farm.file,
      '--farm',
      farm.farm,
      '--county',
      '26091',
      '--tenure',
      'cash_rent',
    ]);

    // pnpm import:seasons <csv>: five crop years for each field.
    const csv = [
      'field,crop_year,crop,variety,planted_on,harvested_on,yield_bu_ac',
      ...farm.names.flatMap((name, i) =>
        [2021, 2022, 2023, 2024, 2025].map(
          (y) =>
            `${name},${y},${(y + i) % 2 ? 'soybeans' : 'corn'},V-${y},${y}-05-0${(y % 7) + 1},${y}-10-1${y % 9},${(y + i) % 2 ? 55.5 : 188.25}`,
        ),
      ),
    ].join('\r\n');
    const csvFile = path.join(dir, `seasons-${key}.csv`);
    await writeFile(csvFile, `﻿${csv}\r\n`);
    await cli(path.join('scripts', 'import-seasons.ts'), [csvFile]);

    // A landlord, as /admin/parties would link one (field-data-parties.spec drives that page).
    const landlord = await pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles, phone, source)
       values ('person', $1, array['landlord'], '(517) 555-0142', 'app') returning id::text`,
      [`E2E Landlord ${key}`],
    );
    await pool.query(`update farm.fields set landlord_party_id = $1 where name = $2`, [
      landlord.rows[0]?.id,
      farm.names[0],
    ]);
    const ids = await pool.query<{ id: string; name: string }>(
      `select id::text, name from farm.fields where name = any($1::text[]) and active`,
      [farm.names],
    );
    expect(ids.rows).toHaveLength(2);
    const west = ids.rows.find((r) => r.name === farm.names[0]) as { id: string };

    // The board: both imported fields drawn; tapping the west one opens it.
    const page = await openBoard(ctx);
    const [lng, lat] = farm.inside[0];
    await jumpTo(page, [lng + 0.0012, lat], 16);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.__map
                ?.queryRenderedFeatures({ layers: ['fields-fill'] })
                .map((f) => String(f.properties.id)) ?? [],
          ),
        { timeout: 20_000 },
      )
      .toEqual(expect.arrayContaining(ids.rows.map((r) => r.id)));
    await tapAt(page, lng, lat);
    const panel = page.getByTestId('field-panel');
    await expect(panel).toHaveAttribute('data-field-id', west.id);
    await expect(panel).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('field-panel-title')).toHaveText(farm.names[0]);
    await expect(panel.locator('[data-testid="field-party"][data-role="Landlord"]')).toContainText(
      `E2E Landlord ${key}`,
    );
    await expect(panel.getByTestId('season-row')).toHaveCount(5);
    await expect(panel.getByTestId('season-row').first()).toContainText('2025');

    await page.getByTestId('field-tab-soils').click();
    await expect(panel.getByTestId('field-soils')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('field-soils-row').first()).toBeVisible();
    await expect(panel.getByTestId('field-soils-nccpi')).toBeVisible();
  } finally {
    await ctx.close();
    await pool.query(
      `delete from farm.fields where farm_id in (select id from farm.farms where name = $1)`,
      [farm.farm],
    );
    await pool.query('delete from farm.farms where name = $1', [farm.farm]);
    await pool.query(`delete from farm.parties where display_name = $1`, [`E2E Landlord ${key}`]);
  }
});

// ---------------------------------------------------------------------------------------------
// 1d
// ---------------------------------------------------------------------------------------------

test('1d: offline, basemap, fields, soils, parcels, tile lines and the fleet draw; aerial photos say offline', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const ctx = await wallContext(browser, 'manager');
  let lineId: string | null = null;
  let lineVersion: string | null = null;
  try {
    // A drawn tile line inside a demo field (POST /api/tile-lines, as the Tile tool saves one).
    const [f] = await demoFieldPoints(1);
    if (!f) throw new Error('no demo field');
    const created = await ctx.request.post('/api/tile-lines', {
      data: {
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [f.lng - 0.0008, f.lat],
              [f.lng + 0.0008, f.lat],
            ],
          ],
        },
        kind: 'main',
        sizeIn: 6,
        notes: 'm1-demo',
      },
    });
    expect(created.status()).toBe(201);
    const line = (await created.json()).line as { id: string; version: string };
    lineId = line.id;
    lineVersion = line.version;

    const page = await ctx.newPage();
    const blocked = await blockExternalHosts(page, baseURL);
    await page.goto('/board');
    await waitForMap(page, 90_000);
    await jumpTo(page, [f.lng, f.lat], 14);

    // Basemap (the local PMTiles: labels from local fonts), fields and the simulated fleet.
    await expect(page.getByTestId('badge-basemap-missing')).toHaveCount(0);
    const basemapDrawn = () =>
      page.evaluate(() => {
        const m = window.__map;
        if (!m) return 0;
        const own = m
          .layerIds()
          .filter((id) => !id.startsWith('layer:') && !id.startsWith('fields'));
        return m.queryRenderedFeatures({ layers: own }).length;
      });
    await expect.poll(basemapDrawn, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => rendered(page, 'fields-fill'), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.__map?.fleet().length ?? 0), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // Soils, parcels and tile lines from the rail.
    for (const [key, layer] of [
      ['soils', 'layer:soils:fill'],
      ['parcels', 'layer:parcels:line'],
      ['tile_lines', 'layer:tile_lines:line'],
    ] as const) {
      await railOn(page, key);
      await expect
        .poll(() => rendered(page, layer), { timeout: 20_000, message: `${key} drawn` })
        .toBeGreaterThan(0);
    }

    // The online-only aerial photos: their tiles can't load, and the rail says so.
    await railOn(page, 'naip');
    await expect(page.getByTestId('layer-status-naip')).toContainText(/offline/i, {
      timeout: 30_000,
    });
    // The only requests that tried to leave were the online imagery's (blocked as the WAN is).
    expect(
      blocked.filter((u) => !/nationalmap\.gov|USGSNAIPImagery/i.test(u)),
      'requests to non-local hosts besides the online imagery',
    ).toEqual([]);
  } finally {
    if (lineId && lineVersion) {
      await ctx.request
        .delete(`/api/tile-lines/${lineId}?version=${encodeURIComponent(lineVersion)}`)
        .catch(() => {});
    }
    await ctx.close();
  }
});
