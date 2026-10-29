/**
 * Plan 1a "tap a field" end to end, on the wall (/board) and the phone (/m): a field seeded into
 * the app's database is tapped on the map and its panel opens within the 200 ms budget with the
 * boundary highlighted, acres, tenure, landlord, farm, five seasons, the open-jobs placeholder
 * and notes; it closes with the X, Escape and a tap on empty map; a manager's notes edit reaches
 * a second screen within 2 s; a viewer has no editor and the server refuses their save.
 *
 * Fields are seeded per project in an empty corner south of the demo farm (so taps can't hit
 * a demo field or the other project's fields) and removed afterwards. Sessions come from
 * signInAs (docs/contracts-m1.md §2): 'viewer' to read, 'manager' (ROLE_FOR.editFieldNotes) to
 * edit.
 */
import { randomBytes } from 'node:crypto';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig, getE2eSettings } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import { type SheetSnap, snapHeights } from '../src/ui/fields/sheet';
import { signInAs } from './support/auth';
import { installFakeRealtime, mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
// One worker per project runs this file in order: the seeded fields sit at fixed places.
test.describe.configure({ mode: 'default' });

/** The plan's budget for tap → panel (1a done-when). */
const TAP_BUDGET_MS = 200;
/** Of that, the panel's own part: from the board handing it the field to its data on screen. */
const PANEL_PATH_MS = 100;
/** Realtime: a change on one screen shows on the others within 2 s. */
const PROPAGATION_MS = 2_000;
const SIDE_M = 400;
const BASE_URL = getE2eSettings().baseURL;

interface Seeded {
  id: string;
  farmId: string;
  name: string;
  center: { lng: number; lat: number };
}

let pool: Pool;
const fields: Seeded[] = [];
let landlordId: string;
const tag = randomBytes(3).toString('hex');

const isPhone = () => test.info().project.name === 'phone';

test.beforeAll(async () => {
  const project = test.info().project.name;
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  const db = createDb(pool);
  // Leftovers of an interrupted run would sit under the same taps.
  await pool.query(`delete from farm.fields where name like $1`, [`E2E ${project} %`]);
  await pool.query(
    `delete from farm.parties p where p.display_name like $1
       and not exists (select 1 from farm.fields f where f.landlord_party_id = p.id)`,
    [`E2E Landlord ${project} %`],
  );
  const p = await pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, phone, email, roles)
     values ('person', $1, '(517) 555-0142', 'e2e-landlord@example.com', '{landlord}')
     returning id`,
    [`E2E Landlord ${project} ${tag}`],
  );
  landlordId = p.rows[0]?.id as string;
  // Seven 400 m squares in a row, 580 m apart; wall and phone use different rows.
  const lat = project === 'phone' ? 41.725 : 41.71;
  for (let i = 0; i < 7; i++) {
    const lng = -83.8 + i * 0.007;
    const name = `E2E ${project} ${i + 1} ${tag}`;
    const geom = squareMultiPolygon(lng, lat, SIDE_M);
    const ids = await insertField(db, { name, geom, tenure: 'cash_rent' });
    const ring = geom.coordinates[0]?.[0] ?? [];
    const [[w = 0, s = 0] = [], , [e = 0, n = 0] = []] = ring;
    fields.push({
      id: ids.fieldId,
      farmId: ids.farmId,
      name,
      center: { lng: (w + e) / 2, lat: (s + n) / 2 },
    });
    await pool.query(`update farm.fields set landlord_party_id = $2, notes = $3 where id = $1`, [
      ids.fieldId,
      landlordId,
      `Gate code ${1000 + i}`,
    ]);
    await pool.query(
      `insert into farm.field_seasons (field_id, crop_year, crop, variety, planted_on,
                                       harvested_on, yield_bu_ac, source)
       select $1, y, case when y % 2 = 0 then 'corn' else 'soybeans' end, 'E2E-' || y,
              make_date(y, 5, 10), make_date(y, 10, 20), 150 + y - 2019, 'import'
         from generate_series(2019, 2025) y`,
      [ids.fieldId],
    );
  }
});

test.afterAll(async () => {
  for (const f of fields) {
    await pool.query('delete from farm.fields where id = $1', [f.id]);
    await pool.query('delete from farm.farms where id = $1', [f.farmId]);
  }
  if (landlordId) await pool.query('delete from farm.parties where id = $1', [landlordId]);
  await pool?.end();
});

/** Browser options of the running project (for extra contexts). */
function contextOptions(): Parameters<Browser['newContext']>[0] {
  return isPhone()
    ? { ...devices['Pixel 7'], baseURL: BASE_URL }
    : {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
        hasTouch: true,
        baseURL: BASE_URL,
      };
}

/** Open the board (wall) or /m (phone) centred on `field`, with its tile drawn. */
async function openAt(page: Page, field: Seeded): Promise<void> {
  if (!page.url().startsWith(BASE_URL)) {
    await page.goto(mapPathFor(test.info()));
    // Software WebGL on a busy machine can take a while to draw the first frame.
    await waitForMap(page, 90_000);
    // Remember the latest touch: the start of a tap.
    await page.evaluate(() => {
      window.addEventListener(
        'touchstart',
        () => {
          (window as unknown as { __tapAt: number }).__tapAt = performance.now();
        },
        { capture: true },
      );
    });
  }
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 15, bearing: 0 }),
    field.center,
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
    .toContain(field.id);
}

/** Tap the map at a WGS84 point (trusted touch), once any camera move has finished. */
async function tapAt(page: Page, lngLat: { lng: number; lat: number }): Promise<void> {
  // The panel may have moved the map to show the boundary (a 600 ms animation).
  await mapIdle(page);
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat), lngLat);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
}

/** How long a tap took, measured in the page (User Timing marks of the panel). */
interface TapTiming {
  /** Tap → the panel's data in the DOM (the budget). */
  total: number;
  /** Tap → the panel in the DOM (the board's click handling, deck.gl's machine pick included). */
  open: number;
  /** Tap → the response parsed. */
  data: number;
}

/** Tap a field, wait for its panel, and say how long it took. */
async function tapField(page: Page, field: Seeded): Promise<TapTiming> {
  await tapAt(page, field.center);
  const panel = page.getByTestId('field-panel');
  await expect(panel).toHaveAttribute('data-field-id', field.id);
  await expect(panel).toHaveAttribute('data-state', 'ready');
  return page.evaluate((id) => {
    const tapAt = (window as unknown as { __tapAt: number }).__tapAt;
    const at = (name: string) =>
      performance
        .getEntriesByName(name)
        .filter((m) => (m as PerformanceMark).detail?.fieldId === id)
        .at(-1)?.startTime;
    const ready = at('field-panel:ready');
    if (ready === undefined || !tapAt) throw new Error('no tap or ready mark');
    return {
      total: ready - tapAt,
      open: (at('field-panel:open') ?? ready) - tapAt,
      data: (at('field-panel:data') ?? ready) - tapAt,
    };
  }, field.id);
}

async function closePanel(page: Page): Promise<void> {
  await page.getByTestId('field-panel-close').click();
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
}

const field = (i: number): Seeded => {
  const f = fields[i];
  if (!f) throw new Error(`no seeded field ${i}`);
  return f;
};

/**
 * The budget is for the panel's path on the wall PC's real GPU. Here the browser draws WebGL in
 * software (SwiftShader): at device scale 2 every frame of the moving fleet, and deck.gl's
 * machine pick on each tap (a readPixels GPU sync in WarRoomMap's click handler, ~150 ms at 4K),
 * cost far more than on any GPU. So this test holds the fleet still (fake realtime: no ticks, no
 * glide) and draws at scale 1; the other tests keep the project's settings and real realtime.
 * It also checks the panel's own share (request, response, render) on its own, which does not
 * depend on the GPU at all.
 */
test.describe('tap → panel budget', () => {
  test.use({ deviceScaleFactor: 1 });
  // A timing budget on a shared machine: a burst of load elsewhere (another suite drawing maps
  // in software) can stall one sample set; a second set decides.
  test.describe.configure({ retries: 2 });

  test('tapping a field opens its panel within 200 ms, with everything 1a asks for', async ({
    context,
    page,
  }) => {
    await signInAs(context, 'viewer');
    await installFakeRealtime(page);
    // Warm-up: the first request of a fresh page loads the route; the budget is for every tap after.
    await openAt(page, field(0));
    const warm = (await tapField(page, field(0))).total;
    expect(warm).toBeLessThan(2_000);
    await closePanel(page);

    // Five fields never opened in this page (the panel caches what it has shown).
    const timings: TapTiming[] = [];
    for (const i of [1, 2, 3, 4, 5]) {
      await openAt(page, field(i));
      timings.push(await tapField(page, field(i)));
      if (i < 5) await closePanel(page);
    }
    const ms = (n: number) => n.toFixed(0);
    const summary = `warm-up ${ms(warm)}; ${timings
      .map((t) => `${ms(t.total)} (open ${ms(t.open)}, data ${ms(t.data)})`)
      .join(', ')}`;
    test.info().annotations.push({ type: 'tap → panel (ms)', description: summary });
    console.log(`[field-panel ${test.info().project.name}] tap → panel ms: ${summary}`);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2] ?? Infinity;
    // The panel's own path (request, response, render), whatever the board's click costs.
    expect(
      median(timings.map((t) => t.total - t.open)),
      `median open → ready; ${summary}`,
    ).toBeLessThan(PANEL_PATH_MS);
    // The whole tap.
    expect(median(timings.map((t) => t.total)), `median tap → panel; ${summary}`).toBeLessThan(
      TAP_BUDGET_MS,
    );

    // The panel of the last field, from the seeded rows.
    const f = field(5);
    const panel = page.getByTestId('field-panel');
    await expect(panel).toHaveAttribute('data-variant', isPhone() ? 'phone' : 'wall');
    await expect(page.getByTestId('field-panel-title')).toHaveText(f.name);
    await expect(page.getByTestId('field-acres')).toHaveText(/^39\.\d ac$/);
    await expect(page.getByTestId('field-tenure')).toHaveText('Cash rent');
    await expect(page.getByTestId('field-farm')).toHaveText('Farm Home farm');
    await expect(page.getByTestId('field-tab-overview')).toHaveAttribute('aria-selected', 'true');
    const party = page.getByTestId('field-party');
    await expect(party).toHaveAttribute('data-role', 'Landlord');
    await expect(party).toContainText(`E2E Landlord ${test.info().project.name} ${tag}`);
    await expect(party.getByRole('link', { name: '(517) 555-0142' })).toHaveAttribute(
      'href',
      'tel:5175550142',
    );
    const rows = page.getByTestId('season-row');
    await expect(rows).toHaveCount(5);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-year')))).toEqual([
      '2025',
      '2024',
      '2023',
      '2022',
      '2021',
    ]);
    await expect(rows.first()).toContainText('Soybeans');
    await expect(rows.first()).toContainText('E2E-2025');
    await expect(rows.first()).toContainText('156.0');
    await expect(page.getByTestId('field-open-jobs')).toContainText(/job board/);
    await expect(page.getByTestId('field-notes-text')).toHaveText('Gate code 1005');
    await expect(page.getByTestId('field-boundary')).toContainText('Imported file');

    // The boundary is highlighted on the map.
    await mapIdle(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['field-panel-selected-line'] })
              .map((x) => String(x.properties.id)) ?? [],
        ),
      )
      .toEqual(expect.arrayContaining([f.id]));
    const highlighted = await page.evaluate(() =>
      window.__map
        ?.queryRenderedFeatures({ layers: ['field-panel-selected-line'] })
        .map((x) => String(x.properties.id)),
    );
    expect(new Set(highlighted)).toEqual(new Set([f.id]));

    // A viewer sees no notes editor.
    await expect(page.getByTestId('field-notes-edit')).toHaveCount(0);
  });
});

test('closes with the X, with Escape and with a tap on empty map; keyboard reaches it', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(context, 'viewer');
  const f = field(0);
  await openAt(page, f);
  await tapField(page, f);
  // Focus moves to the title; Tab reaches the close button, Enter closes.
  await expect(page.getByTestId('field-panel-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('field-panel-close')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('field-panel')).toHaveCount(0);

  await tapField(page, f);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('field-panel')).toHaveCount(0);

  await tapField(page, f);
  // 130 m west of the field (the first of its row): empty map, clear of the badges on top.
  await tapAt(page, { lng: f.center.lng - 0.004, lat: f.center.lat });
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__map?.queryRenderedFeatures({ layers: ['field-panel-selected-line'] }) ?? [],
      ),
    )
    .toEqual([]);

  // Tapping another field switches the panel to it.
  await tapField(page, f);
  const g = field(1);
  await openAt(page, g);
  await tapField(page, g);
  await expect(page.getByTestId('field-panel-title')).toHaveText(g.name);
});

test('a manager edits the notes; a second screen shows them within 2 s; a viewer cannot', async ({
  browser,
  context,
  page,
}) => {
  // Two maps drawn in software (SwiftShader), at 4K on the wall: slow to load, not to react.
  test.setTimeout(180_000);
  const f = field(2);
  // Screen 1: a viewer, panel open on the field.
  await signInAs(context, 'viewer');
  await openAt(page, f);
  await tapField(page, f);
  await expect(page.getByTestId('field-notes-text')).toHaveText('Gate code 1002');
  await expect(page.getByTestId('field-notes-edit')).toHaveCount(0);

  // The server refuses a viewer's save whatever the page shows.
  const version = await page.evaluate(
    async (id) => (await (await fetch(`/api/fields/${id}`)).json()).notes.version as string,
    f.id,
  );
  const refused = await page.request.put(`/api/fields/${f.id}/notes`, {
    data: { text: 'viewer was here', version },
    headers: { origin: new URL(BASE_URL).origin },
  });
  expect(refused.status()).toBe(403);

  // Screen 2: a manager edits.
  const manager: BrowserContext = await browser.newContext(contextOptions());
  try {
    await signInAs(manager, 'manager');
    const mpage = await manager.newPage();
    await openAt(mpage, f);
    await tapField(mpage, f);
    if (!isPhone()) {
      // Wall: 72 px touch targets.
      for (const id of ['field-panel-close', 'field-tab-overview', 'field-notes-edit']) {
        const box = await mpage.getByTestId(id).boundingBox();
        expect(box?.height, id).toBeGreaterThanOrEqual(72);
        expect(box?.width, id).toBeGreaterThanOrEqual(72);
      }
    }
    await mpage.getByTestId('field-notes-edit').click();
    const text = `Washout by the north tile outlet ${randomBytes(2).toString('hex')}`;
    await mpage.getByTestId('field-notes-input').fill(text);
    const saved = mpage.waitForResponse(
      (r) => r.url().endsWith(`/api/fields/${f.id}/notes`) && r.request().method() === 'PUT',
    );
    await mpage.getByTestId('field-notes-save').click();
    expect((await saved).status()).toBe(200);
    const savedAt = Date.now();
    await expect(mpage.getByTestId('field-notes-text')).toHaveText(text);

    // The viewer's open panel follows within 2 s (realtime fields/updated → refetch).
    await expect(page.getByTestId('field-notes-text')).toHaveText(text, {
      timeout: PROPAGATION_MS,
    });
    const took = Date.now() - savedAt;
    test.info().annotations.push({ type: 'notes propagation (ms)', description: String(took) });
    console.log(`[field-panel ${test.info().project.name}] notes propagation ms: ${took}`);
    expect(took).toBeLessThan(PROPAGATION_MS);
    await expect(page.getByTestId('field-notes-edit')).toHaveCount(0);
  } finally {
    await manager.close();
  }
});

test('phone: the sheet snaps by drag and by keyboard, and a drag down closes it', async ({
  context,
  page,
}) => {
  test.skip(!isPhone(), 'the bottom sheet is the phone layout');
  await signInAs(context, 'viewer');
  const f = field(1);
  await openAt(page, f);
  await tapField(page, f);
  const sheet = page.getByTestId('field-panel');
  await expect(sheet).toHaveAttribute('data-snap', 'half');
  const heights = snapHeights(page.viewportSize()?.height ?? 0);
  /** The sheet's top once its height has reached the snap (the CSS transition is over). */
  const settledTop = async (snap: SheetSnap): Promise<number> => {
    await expect
      .poll(async () => Math.round((await sheet.boundingBox())?.height ?? 0))
      .toBe(heights[snap]);
    return (await sheet.boundingBox())?.y ?? 0;
  };

  const handle = page.getByTestId('field-sheet-handle');
  // Keyboard: arrows step through the snaps.
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(sheet).toHaveAttribute('data-snap', 'full');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(sheet).toHaveAttribute('data-snap', 'peek');
  // A tap on the handle opens it again.
  await handle.tap();
  await expect(sheet).toHaveAttribute('data-snap', 'half');

  // Trusted touch drags through CDP (plan §7 "Touch specifics").
  const cdp = await context.newCDPSession(page);
  await settledTop('half');
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  const x = box.x + box.width / 2;
  const drag = async (fromY: number, toY: number, steps: number) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: fromY }],
    });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const y0 = box.y + box.height / 2;
  await drag(y0, 120, 12);
  await expect(sheet).toHaveAttribute('data-snap', 'full');
  const top = await settledTop('full');
  const viewportH = page.viewportSize()?.height ?? 0;
  // Down past the lowest snap: closed.
  await drag(top + 14, viewportH - 10, 16);
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
});
