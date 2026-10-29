/**
 * A field seeded into the app's database renders from /api/tiles/fields: the tile is an MVT with
 * the private cache policy and a ?v= version, and MapLibre draws the field's fill.
 *
 * Seeds through src/test/fixtures (insertField) into the database the running app uses
 * (DATABASE_URL from the env files), and removes the rows afterwards.
 */
import { randomBytes } from 'node:crypto';
import { expect, type Response, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

// Somewhere between Adrian and Blissfield, 600 m square.
const SW = { lng: -83.97, lat: 41.86 };
const CENTER = { lng: SW.lng + 0.0036, lat: SW.lat + 0.0027 };

let pool: Pool;
let seeded: { fieldId: string; farmId: string; name: string };

test.beforeAll(async () => {
  const testInfo = test.info();
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  const name = `e2e ${testInfo.project.name} ${randomBytes(3).toString('hex')}`;
  const ids = await insertField(createDb(pool), {
    name,
    geom: squareMultiPolygon(SW.lng, SW.lat, 600),
    tenure: 'share',
  });
  seeded = { fieldId: ids.fieldId, farmId: ids.farmId, name };
});

test.afterAll(async () => {
  if (seeded) {
    await pool.query('delete from farm.fields where id = $1', [seeded.fieldId]);
    await pool.query('delete from farm.farms where id = $1', [seeded.farmId]);
  }
  await pool?.end();
});

test("a seeded field's tile renders", async ({ page }, testInfo) => {
  const tiles: Response[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/tiles/fields/')) tiles.push(r);
  });
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 14, bearing: 0 }),
    CENTER,
  );
  await mapIdle(page);

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
    .toContain(seeded.fieldId);

  const feature = await page.evaluate(
    (id) =>
      window.__map
        ?.queryRenderedFeatures({ layers: ['fields-fill'] })
        .find((f) => f.properties.id === id),
    seeded.fieldId,
  );
  expect(feature).toMatchObject({
    source: 'fields',
    sourceLayer: 'fields',
    properties: { name: seeded.name, tenure: 'share' },
  });

  const ok = tiles.filter((r) => r.status() === 200);
  expect(ok.length).toBeGreaterThan(0);
  for (const r of ok) {
    expect(r.headers()['content-type']).toBe('application/vnd.mapbox-vector-tile');
    expect(new URL(r.url()).searchParams.get('v')).toMatch(/^[0-9a-f]{12}$/);
    expect(r.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
  }
});
