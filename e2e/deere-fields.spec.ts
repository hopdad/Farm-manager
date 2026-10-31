/**
 * Deere flags on the board and the phone (docs/contracts-1f.md §5.2, done-when §11.1): read-only
 * pins drawn by the "Deere flags" layer (a toggle in the rail's Fields group), a tap on one opens
 * its popup (category, note, field, "From Operations Center (read-only)") and never the field
 * panel under it, a pin tap closes an open field panel, and the popup closes with its X or a tap
 * on the map that hits no pin.
 *
 * Pins and a field are seeded per project in an empty corner south of the demo farm (wall and
 * phone use different rows, away from the other specs' seeded fields) and removed afterwards.
 * Their org (`org-e2e`) is one the stand-in doesn't have, so the running deere.fields job never
 * resolves them. Sessions come from signInAs (contracts-m1 §2): a viewer reads pins.
 */
import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { deterministicId } from '../src/domain/ids';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import { signInAs } from './support/auth';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
// One worker per project runs this file in order: the seeded pins sit at fixed places.
test.describe.configure({ mode: 'default' });

const SIDE_M = 400;
const tag = randomBytes(3).toString('hex');
let pool: Pool;

interface Seeded {
  fieldId: string;
  farmId: string;
  fieldName: string;
  /** The field's centre (a tap there opens the field panel: no pin within reach). */
  fieldCenter: { lng: number; lat: number };
  /** A rock flag on the field. */
  pin: { id: string; lng: number; lat: number };
  /** A wet-spot flag outside any field. */
  loose: { id: string; lng: number; lat: number };
  /** Open ground: no field, no pin. */
  empty: { lng: number; lat: number };
}
let seeded: Seeded;

const isPhone = () => test.info().project.name === 'phone';

async function insertPin(
  p: Pool,
  a: {
    sourceId: string;
    fieldId: string | null;
    lng: number;
    lat: number;
    category: string;
    kind: string;
    note: string;
  },
): Promise<string> {
  const id = deterministicId('deere_flag', a.sourceId);
  await p.query(
    `insert into farm.pins (id, kind, field_id, geom, note, category, read_only, source, source_id,
                            source_org, source_modified_at)
     values ($1, $2, $3, extensions.ST_SetSRID(extensions.ST_MakePoint($4, $5), 4326), $6, $7,
             true, 'deere_flag', $8, 'org-e2e', now())`,
    [id, a.kind, a.fieldId, a.lng, a.lat, a.note, a.category, a.sourceId],
  );
  return id;
}

test.beforeAll(async () => {
  const project = test.info().project.name;
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  // Leftovers of an interrupted run would sit under the same taps.
  await pool.query(`delete from farm.pins where source_org = 'org-e2e' and source_id like $1`, [
    `e2e-${project}-%`,
  ]);
  await pool.query(`delete from farm.fields where name like $1`, [`E2E Flags ${project} %`]);
  const lat = project === 'phone' ? 41.755 : 41.74;
  const lng = -83.62;
  const geom = squareMultiPolygon(lng, lat, SIDE_M);
  const fieldName = `E2E Flags ${project} ${tag}`;
  const ids = await insertField(createDb(pool), { name: fieldName, geom });
  const ring = geom.coordinates[0]?.[0] ?? [];
  const [[w = 0, s = 0] = [], , [e = 0, n = 0] = []] = ring;
  const pinAt = { lng: w + (e - w) * 0.3, lat: s + (n - s) * 0.8 };
  const looseAt = { lng: e + (e - w) * 0.25, lat: (s + n) / 2 };
  seeded = {
    fieldId: ids.fieldId,
    farmId: ids.farmId,
    fieldName,
    fieldCenter: { lng: w + (e - w) * 0.7, lat: s + (n - s) * 0.3 },
    pin: {
      id: await insertPin(pool, {
        sourceId: `e2e-${project}-rock-${tag}`,
        fieldId: ids.fieldId,
        ...pinAt,
        category: 'Rocks',
        kind: 'rock',
        note: `Big rock ${tag}`,
      }),
      ...pinAt,
    },
    loose: {
      id: await insertPin(pool, {
        sourceId: `e2e-${project}-wet-${tag}`,
        fieldId: null,
        ...looseAt,
        category: 'Wet Spot',
        kind: 'wet_hole',
        note: `Soft ground ${tag}`,
      }),
      ...looseAt,
    },
    empty: { lng: w + (e - w) * 0.5, lat: s - (n - s) * 0.4 },
  };
});

test.afterAll(async () => {
  if (seeded) {
    await pool.query('delete from farm.pins where id = any($1::uuid[])', [
      [seeded.pin.id, seeded.loose.id],
    ]);
    await pool.query('delete from farm.fields where id = $1', [seeded.fieldId]);
    await pool.query('delete from farm.farms where id = $1', [seeded.farmId]);
  }
  await pool?.end();
});

/** Open the board (wall) or /m (phone) on the seeded pins, with both drawn. */
async function openOnPins(page: Page): Promise<void> {
  await page.goto(mapPathFor(test.info()));
  await waitForMap(page, 90_000);
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 15, bearing: 0 }),
    seeded.fieldCenter,
  );
  await mapIdle(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['layer:pins:points'] })
              .map((f) => String(f.properties.id)) ?? [],
        ),
      { timeout: 30_000, message: 'the seeded pins drawn by the Deere flags layer' },
    )
    .toEqual(expect.arrayContaining([seeded.pin.id, seeded.loose.id]));
}

/**
 * Phones: a point under an open bottom sheet can't be tapped. Move the map so the point shows
 * two thirds of the way from the top of the map to the sheet (clear of the Fleet button and the
 * weather chip at the top).
 */
async function revealAboveSheet(page: Page, lngLat: { lng: number; lat: number }): Promise<void> {
  if (!isPhone()) return;
  const sheets = ['field-panel', 'pin-popup'];
  let top: number | undefined;
  for (const id of sheets) {
    const el = page.getByTestId(id);
    if ((await el.count()) > 0)
      top = Math.min(top ?? Infinity, (await el.boundingBox())?.y ?? Infinity);
  }
  const mapTop = (await page.getByTestId('war-room-map').boundingBox())?.y;
  if (top === undefined || mapTop === undefined || !Number.isFinite(top)) return;
  const moved = await page.evaluate(
    ({ c, targetY }) => {
      const m = window.__map;
      if (!m) return false;
      const p = m.project(c.lng, c.lat);
      if (Math.abs(p.y - targetY) < 40) return false;
      const pxPerDegLat = p.y - m.project(c.lng, c.lat + 0.001).y;
      const centre = m.center();
      m.jumpTo({ center: [centre.lng, centre.lat - ((p.y - targetY) / pxPerDegLat) * 0.001] });
      return true;
    },
    { c: lngLat, targetY: mapTop + ((top - mapTop) * 2) / 3 },
  );
  if (moved) await mapIdle(page);
}

/** Tap the map at a WGS84 point (trusted touch). */
async function tapAt(page: Page, lngLat: { lng: number; lat: number }): Promise<void> {
  await mapIdle(page);
  await revealAboveSheet(page, lngLat);
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat), lngLat);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
}

test.beforeEach(async ({ context }) => {
  await signInAs(context, 'viewer');
});

test('tapping a flag opens its read-only popup, never the field panel under it', async ({
  page,
}) => {
  await openOnPins(page);
  await tapAt(page, seeded.pin);
  const popup = page.getByTestId('pin-popup');
  await expect(popup).toBeVisible();
  await expect(page.getByTestId('pin-popup-title')).toHaveText('Rocks');
  await expect(page.getByTestId('pin-popup-note')).toHaveText(`Big rock ${tag}`);
  await expect(page.getByTestId('pin-popup-field')).toContainText(seeded.fieldName);
  await expect(page.getByTestId('pin-popup-origin')).toHaveText(
    'From Operations Center (read-only)',
  );
  expect(await page.evaluate(() => window.__pins?.open())).toBe(seeded.pin.id);
  await expect(page.getByTestId('field-panel')).toHaveCount(0);

  // Another flag replaces it; the X closes it.
  await tapAt(page, seeded.loose);
  await expect(page.getByTestId('pin-popup-title')).toHaveText('Wet Spot');
  await expect(page.getByTestId('pin-popup-field')).toContainText('Not on a field');
  await popup.getByRole('button', { name: 'Close' }).click();
  await expect(popup).toHaveCount(0);
});

test('a flag that changes in Operations Center reaches an open board (pins/updated)', async ({
  page,
}) => {
  await openOnPins(page);
  const project = test.info().project.name;
  const at = { lng: seeded.pin.lng + 0.0008, lat: seeded.pin.lat - 0.0006 };
  const id = await insertPin(pool, {
    sourceId: `e2e-${project}-late-${tag}`,
    fieldId: seeded.fieldId,
    ...at,
    category: 'Hazard',
    kind: 'hazard',
    note: `Old well ${tag}`,
  });
  try {
    await pool.query(`select app.publish('pins', 'updated', $1::jsonb)`, [
      JSON.stringify({ fieldIds: [seeded.fieldId], hasUnfielded: false }),
    ]);
    await expect
      .poll(() => page.evaluate(() => window.__pins?.ids() ?? []), { timeout: 10_000 })
      .toContain(id);
    // Resolved in Operations Center: it leaves the map.
    await pool.query(`update farm.pins set resolved_at = now() where id = $1`, [id]);
    await pool.query(`select app.publish('pins', 'updated', $1::jsonb)`, [
      JSON.stringify({ fieldIds: [seeded.fieldId], hasUnfielded: false }),
    ]);
    await expect
      .poll(() => page.evaluate(() => window.__pins?.ids() ?? []), { timeout: 10_000 })
      .not.toContain(id);
  } finally {
    await pool.query('delete from farm.pins where id = $1', [id]);
  }
});

test('a flag tap closes an open field panel; a tap on open ground closes the popup', async ({
  page,
}) => {
  await openOnPins(page);
  await tapAt(page, seeded.fieldCenter);
  await expect(page.getByTestId('field-panel')).toHaveAttribute('data-field-id', seeded.fieldId);
  await tapAt(page, seeded.pin);
  await expect(page.getByTestId('pin-popup')).toBeVisible();
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
  await tapAt(page, seeded.empty);
  await expect(page.getByTestId('pin-popup')).toHaveCount(0);
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
});

test('"Deere flags" is a toggle in the rail that shows and hides the pins', async ({ page }) => {
  await openOnPins(page);
  const rail = page.getByTestId('layer-rail');
  if (!(await rail.isVisible())) await page.getByTestId('layer-rail-toggle').click();
  const toggle = page.getByTestId('layer-toggle-pins');
  await expect(toggle).toContainText('Deere flags');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('layer-group-fields').getByTestId('layer-toggle-pins')).toHaveCount(
    1,
  );
  const drawn = () =>
    page.evaluate(
      () => window.__map?.queryRenderedFeatures({ layers: ['layer:pins:points'] }).length ?? 0,
    );
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(drawn, { timeout: 10_000 }).toBe(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(drawn, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('while a tile line is being drawn, a tap on a flag draws a point and opens no popup', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'wall', 'the draw tool is exercised on the wall');
  await signInAs(context, 'manager');
  await openOnPins(page);
  await page.getByTestId('tile-tool-toggle').click();
  await page.getByTestId('tile-draw-start').click();
  await tapAt(page, seeded.pin);
  await expect(page.getByTestId('tile-draw-hint')).toContainText('1 point');
  await expect(page.getByTestId('pin-popup')).toHaveCount(0);
  await page.getByTestId('tile-cancel').click();
  // Done drawing: the same tap opens the popup again.
  await tapAt(page, seeded.pin);
  await expect(page.getByTestId('pin-popup')).toBeVisible();
});
