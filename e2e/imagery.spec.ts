/**
 * Imagery, parcels and tile maps on the board (plan 1d), over real HTTP against `pnpm pilot`:
 *
 *  - storage write side: a signed PUT (grant minted with the app's secret, as a route handler
 *    would) lands once, a different body is 409, a forged URL 403; the private object is served
 *    only through a signed GET (unsigned 404, private no-store);
 *  - parcels: the private parcels tiles cover the demo fields (synthetic fixture, D7, loaded
 *    first on a local database that has none), owner names in the tiles only for managers (the
 *    tiles route serves the owners variant by role), the parcels layer from the rail and the
 *    Parcels tab of the field panel;
 *  - tile lines: a manager draws a line on a field with the Tile tool; a second manager's board
 *    sees it appear (realtime) and a viewer's private tile_lines tiles carry it; a viewer has no
 *    Tile tool.
 */
import { randomBytes } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { assertLocalUrl } from '../src/db/admin';
import { createPool } from '../src/db/client';
import type { TileLinesResponse, TileLineView } from '../src/db/queries/tile-lines-schema';
import { storageRoot } from '../src/platform/storage/local';
import { LocalStorageWriter } from '../src/platform/storage/writer';
import { tileFor } from '../src/test/fixtures';
import { decodeMvt } from '../tools/gis/mvt';
import { loadSyntheticParcels } from '../tools/gis/parcels';
import { signInAs } from './support/auth';
import { mapIdle, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

interface DemoField {
  id: string;
  name: string;
  lng: number;
  lat: number;
  w: number;
  s: number;
  e: number;
  n: number;
}

let pool: Pool;
let fields: DemoField[] = [];

test.beforeAll(async () => {
  const url = getConfig().DATABASE_URL;
  pool = createPool({ connectionString: url, max: 2 });
  const n = await pool.query<{ n: number }>('select count(*)::int as n from gis.parcels');
  if ((n.rows[0]?.n ?? 0) === 0) {
    assertLocalUrl(url, 'e2e synthetic parcels');
    await loadSyntheticParcels(pool);
  }
  const r = await pool.query<DemoField>(
    `select f.id::text as id, f.name,
            extensions.ST_X(extensions.ST_PointOnSurface(b.geom)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(b.geom)) as lat,
            extensions.ST_XMin(b.geom) as w, extensions.ST_YMin(b.geom) as s,
            extensions.ST_XMax(b.geom) as e, extensions.ST_YMax(b.geom) as n
       from farm.current_boundaries b
       join farm.fields f on f.id = b.field_id and f.active
      order by f.name`,
  );
  fields = r.rows;
});

test.afterAll(async () => {
  await pool?.end();
});

const tileUrl = (layer: string, lng: number, lat: number, z = 14) => {
  const { x, y } = tileFor(lng, lat, z);
  return `/api/tiles/${layer}/${z}/${x}/${y}`;
};

async function tileFeatures(context: BrowserContext, url: string) {
  const res = await context.request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/vnd.mapbox-vector-tile');
  return decodeMvt(new Uint8Array(await res.body()))[0]?.features ?? [];
}

// ---------------------------------------------------------------------------------------------

test.describe('storage write side', () => {
  test('signed PUT once, 409 for other bytes, 403 forged; private GET only when signed', async ({
    request,
  }) => {
    const cfg = getConfig();
    const writer = new LocalStorageWriter(storageRoot(cfg), cfg.SESSION_SECRET);
    const key = `e2e/${randomBytes(6).toString('hex')}.jpg`;
    const body = randomBytes(2048);
    try {
      const grant = await writer.createUploadGrant({
        bucket: 'uploads',
        key,
        contentType: 'image/jpeg',
        bytes: body.length,
      });
      const put = await request.put(grant.url, { headers: grant.headers, data: body });
      expect(put.status()).toBe(201);
      expect((await request.put(grant.url, { headers: grant.headers, data: body })).status()).toBe(
        200,
      );
      expect(
        (
          await request.put(grant.url, { headers: grant.headers, data: randomBytes(2048) })
        ).status(),
      ).toBe(409);
      const forged = grant.url.replace(
        /sig=([^&])/,
        (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`,
      );
      expect((await request.put(forged, { headers: grant.headers, data: body })).status()).toBe(
        403,
      );
      const otherKey = await request.put(grant.url.replace(key, `${key}.x.jpg`), {
        headers: grant.headers,
        data: body,
      });
      expect(otherKey.status()).toBe(403); // the signature names one key

      expect((await request.get(writer.publicUrl('uploads', key))).status()).toBe(404);
      const signed = await writer.createSignedReadUrl('uploads', key, 60);
      const got = await request.get(signed, { headers: { range: 'bytes=0-99' } });
      expect(got.status()).toBe(206);
      expect(got.headers()['cache-control']).toBe('private, no-store');
      expect(Buffer.from(await got.body()).equals(body.subarray(0, 100))).toBe(true);
    } finally {
      await writer.delete('uploads', key).catch(() => false);
    }
  });
});

// ---------------------------------------------------------------------------------------------

test.describe('parcels', () => {
  test('the private parcels tiles cover the demo fields', async ({ context }) => {
    await signInAs(context);
    expect(fields.length).toBeGreaterThan(0);
    const f = fields[0] as DemoField;
    const res = await context.request.get(tileUrl('parcels', f.lng, f.lat));
    expect(res.headers()['cache-control']).toBe('private, no-cache');
    const feats = await tileFeatures(context, tileUrl('parcels', f.lng, f.lat));
    expect(feats.length).toBeGreaterThan(0);
    expect(feats[0]?.properties).toMatchObject({
      parcel_no: expect.stringMatching(/^SYN-/),
      county_fips: expect.stringMatching(/^26(091|115)$/),
    });
    expect(
      (await context.request.get(tileUrl('parcels', f.lng, f.lat, 11))).headers()['content-length'],
    ).toBe('0');
  });

  test('owner names in the tiles only for managers', async ({ browser }) => {
    const f = fields[0] as DemoField;
    const viewer = await browser.newContext();
    const manager = await browser.newContext();
    try {
      await signInAs(viewer);
      await signInAs(manager, 'manager');
      const v = await tileFeatures(viewer, tileUrl('parcels', f.lng, f.lat));
      const m = await tileFeatures(manager, tileUrl('parcels', f.lng, f.lat));
      expect(m.some((x) => typeof x.properties.owner_name === 'string')).toBe(true);
      expect(v.length).toBe(m.length);
      for (const x of v) {
        expect(x.properties).not.toHaveProperty('owner_name');
        expect(x.properties).not.toHaveProperty('owner_mailing');
      }
    } finally {
      await viewer.close();
      await manager.close();
    }
  });

  test('the parcels layer from the rail', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'wall', 'wall only');
    await signInAs(context);
    await page.goto('/board');
    await waitForMap(page);
    const toggle = page.getByTestId('layer-rail-toggle');
    const f = fields[0] as DemoField;
    await page.evaluate((c) => window.__map?.jumpTo({ center: c, zoom: 14 }), [f.lng, f.lat] as [
      number,
      number,
    ]);
    if (!(await page.getByTestId('layer-rail').isVisible())) await toggle.click();
    await page.getByTestId('layer-toggle-parcels').click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              () => window.__map?.queryRenderedFeatures({ layers: ['layer:parcels:line'] }) ?? [],
            )
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  });

  test('the Parcels tab shows a manager the owners', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'wall', 'wall only');
    await signInAs(context, 'manager');
    await page.goto('/board');
    await waitForMap(page);
    const f = fields[fields.length - 1] as DemoField;
    await page.evaluate((c) => window.__map?.jumpTo({ center: c, zoom: 15 }), [f.lng, f.lat] as [
      number,
      number,
    ]);
    await mapIdle(page);
    const p = await page.evaluate((c) => window.__map?.project(c[0], c[1]), [f.lng, f.lat] as [
      number,
      number,
    ]);
    if (!p) throw new Error('map not ready');
    await page.touchscreen.tap(p.x, p.y);
    await expect(page.getByTestId('field-panel')).toBeVisible();
    await page.getByTestId('field-tab-parcels').click();
    await expect(page.getByTestId('field-parcel').first()).toBeVisible();
    await expect(page.getByTestId('field-parcel-owner').first()).not.toHaveText(
      'Owner: managers only',
    );
    await expect(page.getByTestId('field-parcels-source')).toContainText('Synthetic');
  });
});

// ---------------------------------------------------------------------------------------------

/** A demo field with no machine near it (a tap there draws, it doesn't pick a combine). */
async function quietField(page: Page): Promise<DemoField> {
  const machines = await page.evaluate(() =>
    (window.__map?.fleet() ?? []).map((m) => [m.lng, m.lat] as [number, number]),
  );
  let best = fields[0] as DemoField;
  let bestD = -1;
  for (const f of fields) {
    const d = Math.min(
      Number.POSITIVE_INFINITY,
      ...machines.map(([x, y]) => Math.hypot((x - f.lng) * 0.75, y - f.lat)),
    );
    if (d > bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

async function openBoardAt(page: Page, f: DemoField): Promise<void> {
  if (!(await page.evaluate(() => window.__map?.loaded() === true).catch(() => false))) {
    await page.goto('/board');
    // Software WebGL on a busy machine (the whole suite drawing maps) can take a while.
    await waitForMap(page, 90_000);
  }
  await page.evaluate((c) => window.__map?.jumpTo({ center: c, zoom: 15.5 }), [f.lng, f.lat] as [
    number,
    number,
  ]);
  await mapIdle(page);
}

async function tap(page: Page, lng: number, lat: number): Promise<void> {
  const p = await page.evaluate((c) => window.__map?.project(c[0], c[1]), [lng, lat] as [
    number,
    number,
  ]);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
}

const drawnIds = (page: Page) =>
  page.evaluate(() =>
    (window.__map?.queryRenderedFeatures({ layers: ['draw:tile:lines'] }) ?? []).map((f) =>
      String(f.properties.id),
    ),
  );

test.describe('tile lines', () => {
  test('a manager draws a tile line; another board sees it; a viewer’s tiles carry it', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'wall', 'the draw tool is exercised on the wall');
    test.setTimeout(240_000); // three boards with WebGL in software, two at a time
    const drawer = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      hasTouch: true,
    });
    const watcher = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      hasTouch: true,
    });
    const viewer = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      hasTouch: true,
    });
    let created: TileLineView | null = null;
    try {
      await signInAs(drawer, 'manager');
      await signInAs(watcher, 'manager');
      await signInAs(viewer);
      const page = await drawer.newPage();
      await page.goto('/board');
      await waitForMap(page);
      const f = await quietField(page);
      await openBoardAt(page, f);

      // The viewer's board has no Tile tool: checked once that board has asked the server
      // (GET /api/tile-lines answers canEdit: false), then closed. Never three software-WebGL
      // boards live at once: on CI's runner the third one starved past 90 s to load. The
      // viewer's tiles are checked below through its session, without a map.
      const view = await viewer.newPage();
      const viewerAsked = view.waitForResponse(
        (r) => r.url().includes('/api/tile-lines?') && r.request().method() === 'GET',
      );
      await openBoardAt(view, f);
      const asked = await viewerAsked;
      expect(asked.status()).toBe(200);
      expect(((await asked.json()) as TileLinesResponse).canEdit).toBe(false);
      await expect(page.getByTestId('tile-tool-toggle')).toBeVisible();
      await expect(view.getByTestId('tile-tool-toggle')).toHaveCount(0);
      await view.close();

      // The second manager opens the tool and watches.
      const other = await watcher.newPage();
      await openBoardAt(other, f);
      await other.getByTestId('tile-tool-toggle').click();
      await expect(other.getByTestId('tile-tool-panel')).toBeVisible();
      const before = new Set(await drawnIds(other));

      // Draw: two taps inside the field, Done, kind + size + depth, Save.
      await page.getByTestId('tile-tool-toggle').click();
      await page.getByTestId('tile-draw-start').click();
      const x = f.w + (f.e - f.w) * 0.4;
      await tap(page, x, f.s + (f.n - f.s) * 0.2);
      await expect(page.getByTestId('tile-draw-hint')).toContainText('1 point');
      // A person's second tap comes later than the browser's double-tap window (else Chrome
      // makes the pair one double-tap gesture and the second tap is no click).
      await page.waitForTimeout(450);
      await tap(page, x, f.s + (f.n - f.s) * 0.8);
      await expect(page.getByTestId('tile-draw-hint')).toContainText('2 points');
      await page.getByTestId('tile-finish').click();
      await page.getByTestId('tile-kind-main').click();
      await page.getByTestId('tile-size').fill('6');
      await page.getByTestId('tile-depth').fill('4');
      const saved = page.waitForResponse(
        (r) => r.url().endsWith('/api/tile-lines') && r.request().method() === 'POST',
      );
      await page.getByTestId('tile-save').click();
      const res = await saved;
      expect(res.status()).toBe(201);
      created = ((await res.json()) as { line: TileLineView }).line;
      expect(created).toMatchObject({
        fieldId: f.id,
        kind: 'main',
        sizeIn: 6,
        depthFt: 4,
        source: 'app',
      });
      await expect(page.getByTestId('tile-message')).toContainText(`Saved on ${f.name}`);
      const savedAt = Date.now();

      // The other board's tool shows it (layers/updated over realtime), within the budget.
      const id = created.id;
      await expect
        .poll(async () => (await drawnIds(other)).includes(id), { timeout: 10_000 })
        .toBe(true);
      expect(before.has(id)).toBe(false);
      testInfo.annotations.push({ type: 'propagation', description: `${Date.now() - savedAt} ms` });

      // The viewer's private tile_lines tiles carry it.
      const lineTile = await tileFeatures(viewer, tileUrl('tile_lines', x, f.lat, 15));
      expect(lineTile.map((t) => t.properties.id)).toContain(id);

      // Selecting it on the drawing board shows its details.
      await tap(page, x, f.s + (f.n - f.s) * 0.5);
      await expect(page.getByTestId('tile-selected')).toHaveAttribute('data-line-id', id);
      expect(await page.evaluate(() => window.__map?.errors() ?? [])).toEqual([]);
    } finally {
      if (created) {
        await drawer.request.delete(
          `/api/tile-lines/${created.id}?version=${encodeURIComponent(created.version)}`,
        );
      }
      await drawer.close();
      await watcher.close();
      await viewer.close();
    }
  });

  test('a viewer cannot write tile lines through the API', async ({ request }) => {
    const f = fields[0] as DemoField;
    const res = await request.post('/api/tile-lines', {
      data: {
        geometry: {
          type: 'LineString',
          coordinates: [
            [f.lng, f.lat],
            [f.lng, f.lat + 0.001],
          ],
        },
      },
    });
    expect(res.status()).toBe(403);
  });
});
