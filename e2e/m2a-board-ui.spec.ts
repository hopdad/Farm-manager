/**
 * The job board's layouts, drags and job detail (docs/contracts-2a.md §11.2), on the wall
 * (/board, `wall` project) and the phone (/m, `phone` project):
 *
 *  - the wall's band (its height, the map area kept >= 65 % of the screen, four lanes, the chips
 *    tray from the crew and the fleet panel's machines with the "Deere" badge, collapse
 *    remembered on the device, 72 px targets); the phone's Jobs pill and sheet (closed by
 *    default, one sheet at a time with the field panel);
 *  - drags: the card lifts off (the phone sheet drops to peek), the map never pans under a drag,
 *    a drop on empty map or anywhere else changes nothing, a pan or a quick swipe never drags,
 *    the hover highlight follows the field under the pointer, the hidden fields layer drops by
 *    point (the server picks the field);
 *  - the job detail: the status buttons from nextJobStatuses for a manager, a driver on their
 *    own job (and not on another's) and a viewer; Cancel (with a reason) posts to …/cancel; Move
 *    up / Move down send the lane's open jobs in the new order and stop at the edge of the
 *    card's priority; × on an assignment chip; Edit and New job open job-forms' JobForm; a 409
 *    says "Changed on another screen; try again".
 *
 * The job routes are answered by the board's API stand-in (src/ui/work/board/testkit.ts, through
 * page.route) with the spec's own jobs, and realtime is the e2e double; the machines (fleet
 * panel), the crew and the map's fields are the real e2e database's. (The done-when,
 * e2e/m2a-board.spec.ts, is the spec that runs against the real API after the merge.) Fields are
 * seeded per project in an empty corner south of the demo farm and removed afterwards.
 */
import { randomBytes } from 'node:crypto';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig, getE2eSettings } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { deterministicId } from '../src/domain/ids';
import type { Role } from '../src/platform/auth/types';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import { snapHeights } from '../src/ui/fields/sheet';
import {
  createSqlWorld,
  isMockedJobsUrl,
  MockJobsApi,
  type MockViewer,
  makeJobView,
  mockRouteHandler,
} from '../src/ui/work/board/testkit';
import { JOB_CONFLICT_MESSAGE, type JobMachineView, type JobView } from '../src/ui/work/contract';
import { E2E_SOURCE, signInAs } from './support/auth';
import { centerOf, mapPoint, mouseDrag, type Pt } from './support/drag';
import {
  installFakeRealtime,
  mapIdle,
  revealInFreeMap,
  WEBGL_ARGS,
  waitForMap,
} from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
// One worker per project runs this file in order: the seeded fields sit at fixed places.
test.describe.configure({ mode: 'default' });

const BASE_URL = getE2eSettings().baseURL;
const SIDE_M = 400;
const tag = randomBytes(3).toString('hex');
const isPhone = () => test.info().project.name === 'phone';

interface Seeded {
  id: string;
  farmId: string;
  name: string;
  center: { lng: number; lat: number };
}

let pool: Pool;
const fields: Seeded[] = [];
/** An empty spot of the map (no field within a few km). */
const EMPTY = { lng: -83.72, lat: 41.6 };

test.beforeAll(async () => {
  const project = test.info().project.name;
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  await pool.query(
    `delete from farm.farms fa where exists (
       select 1 from farm.fields f where f.farm_id = fa.id and f.name like $1)`,
    [`E2E m2a-ui ${project} %`],
  );
  const db = createDb(pool);
  const lat = project === 'phone' ? 41.655 : 41.67;
  for (const [i, lng] of [-83.725, -83.715].entries()) {
    const name = `E2E m2a-ui ${project} ${i + 1} ${tag}`;
    const geom = squareMultiPolygon(lng, lat, SIDE_M);
    const ids = await insertField(db, { name, geom });
    // (lng, lat) is the square's south-west corner: aim at the middle.
    const [[w = 0, s = 0] = [], , [e = 0, n = 0] = []] = geom.coordinates[0]?.[0] ?? [];
    fields.push({
      id: ids.fieldId,
      farmId: ids.farmId,
      name,
      center: { lng: (w + e) / 2, lat: (s + n) / 2 },
    });
  }
});

test.afterAll(async () => {
  for (const f of fields) {
    await pool.query('delete from farm.fields where id = $1', [f.id]);
    await pool.query('delete from farm.farms where id = $1', [f.farmId]);
  }
  await pool?.end();
});

const field = (i: number): Seeded => {
  const f = fields[i];
  if (!f) throw new Error(`no seeded field ${i}`);
  return f;
};

const partyOf = (role: Exclude<Role, 'viewer'>) => deterministicId(E2E_SOURCE, `party:${role}`);
const jobId = (key: string) => deterministicId('e2e', `job:m2a-ui:${key}`);
const ID = {
  request: jobId('request'),
  second: jobId('second'),
  third: jobId('third'),
  driverOwn: jobId('driver-own'),
  daleHarvest: jobId('dale-harvest'),
  haul: jobId('haul'),
  store: jobId('store'),
  extra: jobId('extra'),
};

async function machineByUnit(unit: string): Promise<JobMachineView> {
  const r = await pool.query<{ id: string }>(
    `select id::text as id from farm.machines where unit_no = $1 order by id limit 1`,
    [unit],
  );
  const id = r.rows[0]?.id;
  const m = id ? await createSqlWorld((t, v) => pool.query(t, v)).machine(id) : null;
  if (!m) throw new Error(`no machine ${unit}`);
  return m;
}

/** The spec's jobs (the stand-in's world: the real machines, crew and the seeded fields). */
async function seedJobs(api: MockJobsApi): Promise<void> {
  const sp2 = await machineByUnit('SP2');
  const c1 = await machineByUnit('C1');
  const f = field(0);
  const daleRow = await pool.query<{ id: string }>(
    `select id::text as id from farm.parties where display_name = 'Dale Mercer' limit 1`,
  );
  const dale = daleRow.rows[0]?.id as string;
  const jobs: (Partial<JobView> & Pick<JobView, 'id' | 'kind'>)[] = [
    { id: ID.request, kind: 'spray', status: 'requested', title: 'E2E request', sortKey: 10 },
    { id: ID.second, kind: 'spray', status: 'planned', title: 'E2E second', sortKey: 20 },
    { id: ID.third, kind: 'spray', status: 'planned', title: 'E2E third', sortKey: 30 },
    {
      id: ID.driverOwn,
      kind: 'spray',
      status: 'assigned',
      title: 'E2E driver’s own',
      priority: 2,
      field: { id: f.id, name: f.name, farmName: 'Home farm', boundaryAcres: 39.5 },
      plannedAcres: 39.5,
      assignments: [
        {
          id: jobId('driver-own:assignment:1'),
          role: 'operator',
          machine: sp2,
          person: { partyId: partyOf('driver'), name: 'E2E Driver', initials: 'ED' },
          plannedFor: null,
          alsoOn: [],
        },
      ],
    },
    {
      id: ID.daleHarvest,
      kind: 'harvest',
      businessLine: 'grain',
      status: 'in_progress',
      title: 'E2E Dale’s harvest',
      priority: 1,
      assignments: [
        {
          id: jobId('dale-harvest:assignment:1'),
          role: 'operator',
          machine: c1,
          person: { partyId: dale, name: 'Dale Mercer', initials: 'DM' },
          plannedFor: null,
          alsoOn: [],
        },
      ],
    },
    { id: ID.haul, kind: 'haul', businessLine: 'trucking', status: 'planned', title: 'E2E haul' },
    { id: ID.store, kind: 'other', businessLine: 'store', status: 'planned', title: 'E2E store' },
    { id: ID.extra, kind: 'scout', status: 'planned', title: 'E2E scout', priority: 4 },
  ];
  for (const j of jobs) api.put(makeJobView({ businessLine: 'spraying', ...j }));
}

const contextOptions = (): Parameters<Browser['newContext']>[0] =>
  isPhone()
    ? { ...devices['Pixel 7'], baseURL: BASE_URL }
    : {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        hasTouch: true,
        baseURL: BASE_URL,
      };

interface Board {
  context: BrowserContext;
  page: Page;
  api: MockJobsApi;
  /** Non-GET requests the stand-in answered. */
  writes(): { method: string; path: string; body: unknown }[];
}

/** A screen of the given role with the stand-in API and the realtime double, board open. */
async function openBoard(browser: Browser, role: Role): Promise<Board> {
  const context = await browser.newContext(contextOptions());
  await signInAs(context, role);
  const api = new MockJobsApi(createSqlWorld((t, v) => pool.query(t, v)));
  await seedJobs(api);
  const viewer: MockViewer = { role, partyId: role === 'viewer' ? null : partyOf(role) };
  const page = await context.newPage();
  await installFakeRealtime(page);
  // The board's drop log (WorkBoardProvider's test seam): what each drop resolved to.
  await page.addInitScript(() => {
    (window as unknown as { __workBoardDrops: unknown[] }).__workBoardDrops = [];
  });
  await context.route(isMockedJobsUrl, mockRouteHandler(api, viewer));
  let seq = 0;
  api.onChange((payload) => {
    seq += 1;
    void page
      .evaluate(
        ({ payload, seq }) => window.__fleetEmit?.('jobs', { event: 'updated', payload, seq }),
        { payload, seq },
      )
      .catch(() => {});
  });
  await page.goto(isPhone() ? '/m' : '/board');
  await waitForMap(page, 90_000);
  return { context, page, api, writes: () => api.requests.filter((r) => r.method !== 'GET') };
}

const card = (page: Page, id: string) =>
  page.locator(`[data-testid="job-card"][data-job-id="${id}"]`);

async function jumpTo(page: Page, c: { lng: number; lat: number }, zoom = 15): Promise<void> {
  await page.evaluate(
    ({ c, zoom }) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom, bearing: 0 }),
    { c, zoom },
  );
  await mapIdle(page);
}

async function showField(page: Page, f: Seeded): Promise<void> {
  await jumpTo(page, f.center);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['fields-fill'] })
              .map((x) => String(x.properties.id)) ?? [],
        ),
      { timeout: 20_000 },
    )
    .toContain(f.id);
  await revealInFreeMap(page, f.center);
}

/** Phones: open the jobs sheet (it opens at half). The wall's band is always there. */
async function showJobs(page: Page): Promise<void> {
  if (!isPhone()) {
    await expect(page.getByTestId('jobs-band')).toBeVisible();
    return;
  }
  await page.getByTestId('jobs-pill').tap();
  await sheetAt(page, 'half');
}

async function sheetAt(page: Page, snap: 'peek' | 'half' | 'full'): Promise<void> {
  const sheet = page.getByTestId('jobs-sheet');
  await expect(sheet).toHaveAttribute('data-snap', snap);
  const h = snapHeights(page.viewportSize()?.height ?? 0)[snap];
  await expect.poll(async () => Math.round((await sheet.boundingBox())?.height ?? 0)).toBe(h);
}

/** The job detail of a card (wall: popover; phone: the sheet's detail view). */
async function openDetail(page: Page, id: string): Promise<Locator> {
  const c = card(page, id);
  await c.scrollIntoViewIfNeeded();
  await c.locator('button').first().tap();
  const detail = page.getByTestId('job-detail');
  await expect(detail).toHaveAttribute('data-job-id', id);
  return detail;
}

async function closeDetail(page: Page): Promise<void> {
  if (isPhone()) await page.getByTestId('jobs-sheet-back').tap();
  else await page.getByTestId('job-detail-close').tap();
  await expect(page.getByTestId('job-detail')).toHaveCount(0);
}

const center = (page: Page) => page.evaluate(() => window.__map?.center() ?? null);

/** What the board's drops resolved to, in order (`window.__workBoardDrops`). */
const drops = (page: Page) =>
  page.evaluate(() =>
    (
      (window as unknown as { __workBoardDrops?: { at: { kind: string } }[] }).__workBoardDrops ??
      []
    ).map((d) => d.at.kind),
  );

/** A trusted touch that starts dragging a card and stays down (the caller lifts it). */
async function holdCard(page: Page, c: Locator): Promise<{ at: Pt; lift(to: Pt): Promise<void> }> {
  // A card's centre may be scrolled out of its lane: bring the whole card into view first.
  await c.scrollIntoViewIfNeeded();
  const cdp = await page.context().newCDPSession(page);
  const from = await centerOf(c);
  const pt = (p: Pt) => ({ x: p.x, y: p.y, id: 0, radiusX: 4, radiusY: 4, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from)] });
  await page.waitForTimeout(350);
  let at = from;
  for (let i = 1; i <= 4; i++) {
    at = { x: from.x, y: from.y - i * 6 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(at)] });
    await page.waitForTimeout(16);
  }
  return {
    at,
    async lift(to: Pt) {
      for (let i = 1; i <= 8; i++) {
        const p = { x: at.x + ((to.x - at.x) * i) / 8, y: at.y + ((to.y - at.y) * i) / 8 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(p)] });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(150);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach().catch(() => {});
    },
  };
}

/** A one-finger trusted swipe with no hold (a scroll or a map pan, never a drag). */
async function swipe(page: Page, from: Pt, to: Pt): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = (p: Pt) => ({ x: p.x, y: p.y, id: 0, radiusX: 4, radiusY: 4, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from)] });
  for (let i = 1; i <= 8; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(p)] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach().catch(() => {});
}

// ---------------------------------------------------------------------------------------------

test('wall: the band (≥ 65 % map), lanes, chips with the Deere badge, collapse remembered', async ({
  browser,
}) => {
  test.skip(isPhone(), 'the band is the wall layout');
  test.setTimeout(120_000);
  const b = await openBoard(browser, 'manager');
  const { page } = b;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const band = page.getByTestId('jobs-band');
    await expect(band).toHaveAttribute('data-variant', 'wall');
    await expect(band).toHaveAttribute('data-collapsed', 'false');
    const vh = page.viewportSize()?.height ?? 1080;
    expect(Math.round((await band.boundingBox())?.height ?? 0)).toBe(208);
    const mapH = (await page.getByTestId('war-room-map').boundingBox())?.height ?? 0;
    console.log(
      `[m2a-board-ui] wall map area ${mapH} of ${vh} px (${Math.round((mapH / vh) * 100)} %)`,
    );
    expect(mapH / vh).toBeGreaterThanOrEqual(0.65);
    // The fleet panel, the rail, the weather strip and the map controls stay on screen.
    for (const id of ['fleet-panel', 'layer-rail', 'weather-strip']) {
      await expect(page.getByTestId(id).first()).toBeVisible();
    }
    // Four lanes in BUSINESS_LINES order; cards in lane order (priority, then sort key).
    await expect(page.getByTestId('jobs-lane')).toHaveCount(4);
    const lines = await page
      .getByTestId('jobs-lane')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-business-line')));
    expect(lines).toEqual(['spraying', 'grain', 'trucking', 'store']);
    const spraying = page.locator('[data-testid="jobs-lane"][data-business-line="spraying"]');
    const order = await spraying
      .getByTestId('job-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-job-id')));
    expect(order).toEqual([ID.driverOwn, ID.request, ID.second, ID.third, ID.extra]);
    const c = card(page, ID.driverOwn);
    await expect(c).toHaveAttribute('data-status', 'assigned');
    await expect(c).toHaveAttribute('data-field-id', field(0).id);
    await expect(c.getByTestId('job-assignment-label')).toHaveText('SP2 · E2E Driver');
    // SP2 (a Samsara-gatewayed RoGator) can't take a Work Plan: no badge, in the tray or on a card.
    await expect(c.getByTestId('job-assignment-chip')).not.toContainText('Deere');
    await expect(card(page, ID.request).locator('[data-flag="no_field"]')).toHaveCount(1);
    // The chips: crew from GET /api/v1/crew, machines from the fleet panel (not retired).
    const tray = page.getByTestId('jobs-chips-tray');
    await expect(tray.locator('[data-testid="chip-person"][aria-label="Dale Mercer"]')).toHaveCount(
      1,
    );
    await expect(tray.locator('[data-testid="chip-machine"][data-unit="SP2"]')).toHaveAttribute(
      'data-work-plan',
      'false',
    );
    await expect(tray.locator('[data-testid="chip-machine"][data-unit="SP1"]')).toHaveAttribute(
      'data-work-plan',
      'true',
    );
    await expect(tray.locator('[data-testid="chip-machine"][data-unit="SP1"]')).toContainText(
      'Deere',
    );
    expect(b.api.calls('GET', '/api/v1/crew').length).toBeGreaterThan(0);
    // 72 px targets.
    for (const t of [
      page.getByTestId('jobs-band-toggle'),
      page.getByTestId('job-new'),
      tray.getByTestId('chip-machine').first(),
      tray.getByTestId('chip-person').first(),
    ]) {
      const box = await t.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(72);
      expect(box?.width).toBeGreaterThanOrEqual(72);
    }

    // Collapse: a thin bar, the map grows; remembered on this device.
    await page.getByTestId('jobs-band-toggle').tap();
    await expect(band).toHaveAttribute('data-collapsed', 'true');
    expect(Math.round((await band.boundingBox())?.height ?? 0)).toBe(72);
    await expect(page.getByTestId('job-card')).toHaveCount(0);
    await expect(page.getByTestId('jobs-band-summary')).toContainText('8 open');
    await page.reload();
    await waitForMap(page, 90_000);
    await expect(page.getByTestId('jobs-band')).toHaveAttribute('data-collapsed', 'true');
    await page.getByTestId('jobs-band-toggle').tap();
    await expect(page.getByTestId('jobs-band')).toHaveAttribute('data-collapsed', 'false');
    await expect(card(page, ID.request)).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await b.context.close();
  }
});

test('phone: the Jobs pill opens the sheet (closed by default); one sheet at a time', async ({
  browser,
}) => {
  test.skip(!isPhone(), 'the pill and the sheet are the phone layout');
  test.setTimeout(120_000);
  const b = await openBoard(browser, 'manager');
  const { page } = b;
  try {
    // Closed by default; the pill third in the top-left stack.
    await expect(page.getByTestId('jobs-sheet')).toHaveCount(0);
    const pill = page.getByTestId('jobs-pill');
    await expect(pill).toContainText('Jobs');
    const box = await pill.boundingBox();
    expect(box?.x).toBeCloseTo(12, 0);
    expect(box?.y).toBeGreaterThan((await page.getByTestId('weather-chip').boundingBox())?.y ?? 0);
    await showJobs(page);
    const sheet = page.getByTestId('jobs-sheet');
    await expect(sheet.getByTestId('jobs-chips-tray')).toBeVisible();
    await expect(card(page, ID.request)).toBeVisible();
    // 48 px targets.
    for (const t of [
      page.getByTestId('jobs-sheet-close'),
      page.getByTestId('job-new'),
      sheet.getByTestId('chip-machine').first(),
      sheet.getByTestId('chip-person').first(),
    ]) {
      expect((await t.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    }
    // The handle steps through the snaps.
    await page.getByTestId('jobs-sheet-handle').tap();
    await sheetAt(page, 'full');
    await page.getByTestId('jobs-sheet-handle').tap();
    await sheetAt(page, 'half');

    // A field tapped on the map: the field panel opens, the jobs sheet closes.
    const f = field(1);
    await page.getByTestId('jobs-sheet-close').tap();
    await expect(sheet).toHaveCount(0);
    await jumpTo(page, f.center);
    await showJobs(page);
    // Pan so the field shows above the half sheet, as someone would, and tap it there.
    const sheetTop = (await sheet.boundingBox())?.y ?? 0;
    const mapTop = (await page.getByTestId('war-room-map').boundingBox())?.y ?? 0;
    await page.evaluate(
      ({ c, targetY }) => {
        const m = window.__map;
        if (!m) return;
        const p = m.project(c.lng, c.lat);
        const pxPerDegLat = p.y - m.project(c.lng, c.lat + 0.001).y;
        const centre = m.center();
        m.jumpTo({ center: [centre.lng, centre.lat - ((p.y - targetY) / pxPerDegLat) * 0.001] });
      },
      { c: f.center, targetY: (mapTop + 120 + sheetTop) / 2 },
    );
    await mapIdle(page);
    const p = await mapPoint(page, f.center);
    expect(p.y).toBeLessThan(sheetTop);
    await page.touchscreen.tap(p.x, p.y);
    await expect(page.getByTestId('field-panel')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    // The jobs sheet again: the field panel closes.
    await pill.tap();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('field-panel')).toHaveCount(0);
  } finally {
    await b.context.close();
  }
});

test('a drag lifts the card (phone: sheet to peek) and never pans the map; empty map, outside, a pan or a swipe change nothing', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const b = await openBoard(browser, 'manager');
  const { page } = b;
  try {
    await jumpTo(page, EMPTY);
    await revealInFreeMap(page, EMPTY);
    await showJobs(page);
    const c = card(page, ID.request);
    await c.scrollIntoViewIfNeeded();
    const before = await center(page);

    // Held: the overlay follows the finger; on phones the sheet drops to peek, the chips in view.
    const hold = await holdCard(page, c);
    await expect(page.getByTestId('job-drag-overlay')).toBeVisible();
    await expect(page.getByTestId('job-drag-overlay')).toHaveAttribute('data-job-id', ID.request);
    await expect(page.getByTestId('jobs-map-drop')).toHaveAttribute('data-dragging', 'true');
    if (isPhone()) {
      await sheetAt(page, 'peek');
      await expect(page.getByTestId('jobs-chips-tray')).toBeInViewport();
    }
    // Across the map to an empty spot: the map doesn't pan, nothing is written.
    await hold.lift(await mapPoint(page, EMPTY));
    await expect(page.getByTestId('job-drag-overlay')).toHaveCount(0);
    expect(await center(page)).toEqual(before);
    if (isPhone()) await sheetAt(page, 'half');
    await expect(page.getByTestId('job-notice')).toContainText('inside a field');
    expect(await drops(page)).toEqual(['map']);
    expect(b.writes()).toEqual([]);

    // Outside the map and the chips (wall: on the weather strip; phone: on the sheet): nothing.
    // (Phones: the sheet's title row once it has dropped to peek.)
    const vh = page.viewportSize()?.height ?? 0;
    const outside = isPhone()
      ? { x: 60, y: vh - snapHeights(vh).peek + 26 }
      : await centerOf(page.getByTestId('weather-strip').first());
    const again = await holdCard(page, c);
    if (isPhone()) await sheetAt(page, 'peek');
    await again.lift(outside);
    await expect(page.getByTestId('job-drag-overlay')).toHaveCount(0);
    expect(await drops(page)).toEqual(['map', 'none']);
    expect(b.writes()).toEqual([]);
    await expect(c).toHaveAttribute('data-version', '1');

    // A pan on the map pans it (gestures back after the drags) and never drags a card.
    const mapBox = await page.getByTestId('war-room-map').boundingBox();
    if (!mapBox) throw new Error('no map');
    const start = isPhone()
      ? { x: mapBox.x + mapBox.width / 2, y: mapBox.y + 120 }
      : { x: mapBox.x + mapBox.width / 2, y: mapBox.y + mapBox.height / 2 - 60 };
    await swipe(page, start, { x: start.x + 120, y: start.y + 40 });
    await mapIdle(page);
    expect(await center(page)).not.toEqual(before);
    await expect(page.getByTestId('job-drag-overlay')).toHaveCount(0);

    // A quick swipe on a card scrolls its lane (wall) or the list (phone), never drags it.
    const scroller = isPhone()
      ? page.locator('[data-testid="jobs-sheet"] > div').last()
      : page.locator('[data-testid="jobs-lane"][data-business-line="spraying"] > div');
    const box = await scroller.boundingBox();
    if (!box) throw new Error('no scroller');
    const scrolledBefore = await scroller.evaluate((el) => el.scrollLeft + el.scrollTop);
    // On the first card in view (a card's centre may be scrolled out of its lane).
    const from = isPhone()
      ? { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 20, 160) }
      : { x: box.x + 80, y: box.y + box.height / 2 };
    const hit = await page.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.closest('[data-testid="job-card"]') !== null,
      from,
    );
    expect(hit, 'the swipe starts on a card').toBe(true);
    await swipe(
      page,
      from,
      isPhone() ? { x: from.x, y: from.y - 150 } : { x: from.x - 180, y: from.y },
    );
    await expect(page.getByTestId('job-drag-overlay')).toHaveCount(0);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollLeft + el.scrollTop))
      .toBeGreaterThan(scrolledBefore);
    expect(b.writes()).toEqual([]);
  } finally {
    await b.context.close();
  }
});

test('wall, mouse: the hover highlight follows the field; with the fields layer hidden the drop goes by point', async ({
  browser,
}) => {
  test.skip(isPhone(), 'a mouse drag on the wall');
  test.setTimeout(120_000);
  const b = await openBoard(browser, 'manager');
  const { page } = b;
  try {
    const f = field(1);
    await showField(page, f);
    const c = card(page, ID.request);
    await c.scrollIntoViewIfNeeded();
    const from = await centerOf(c);
    const onField = await mapPoint(page, f.center);
    const hovered = () =>
      page.evaluate(
        () =>
          window.__map
            ?.queryRenderedFeatures({ layers: ['work-drop-hover-fill'] })
            .map((x) => String(x.properties.id)) ?? [],
      );
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 12, { steps: 3 });
    await page.mouse.move(onField.x, onField.y, { steps: 12 });
    await expect(page.getByTestId('job-drag-overlay')).toBeVisible();
    await expect(page.getByTestId('jobs-map-drop')).toHaveAttribute('data-over', 'true');
    await expect.poll(hovered, { timeout: 5_000 }).toContain(f.id);
    // Off the field: the highlight matches nothing.
    await page.mouse.move(onField.x + 300, onField.y, { steps: 6 });
    await expect.poll(hovered).toEqual([]);
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() => window.__map?.layerIds().filter((id) => id.startsWith('work-drop'))),
      )
      .toEqual([]);
    expect(b.writes()).toEqual([]);

    // The fields layer hidden on the rail: the drop sends the point; the server picks the field.
    await page.getByTestId('layer-toggle-fields').tap();
    await expect(page.getByTestId('layer-toggle-fields')).toHaveAttribute('aria-pressed', 'false');
    await c.scrollIntoViewIfNeeded();
    await mouseDrag(page, await centerOf(c), await mapPoint(page, f.center));
    await expect(c).toHaveAttribute('data-field-id', f.id);
    const put = b.api.calls('PUT', `/api/v1/jobs/${ID.request}/field`);
    expect(put).toHaveLength(1);
    expect(put[0]?.body).toMatchObject({ version: 1, at: { lng: expect.any(Number) } });
    const at = (put[0]?.body as { at?: { lng: number } } | undefined)?.at;
    expect(Math.abs((at?.lng ?? 0) - f.center.lng)).toBeLessThan(0.002);
    await page.getByTestId('layer-toggle-fields').tap();
  } finally {
    await b.context.close();
  }
});

test('the job detail for a manager: accept, start, ×, move up / down, cancel with a reason, edit, new job, the 409', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const b = await openBoard(browser, 'manager');
  const { page, api } = b;
  const status = (d: Locator) => d.getByTestId('job-detail-status');
  try {
    await showJobs(page);
    // Accept a request.
    let d = await openDetail(page, ID.request);
    await expect(d.getByTestId('job-status-actions').getByRole('button')).toHaveText([
      'Accept request',
      'Cancel job',
    ]);
    await d.getByTestId('job-status-planned').tap();
    await expect(status(d)).toHaveAttribute('data-status', 'planned');
    expect(api.calls('POST', `/api/v1/jobs/${ID.request}/status`)[0]?.body).toEqual({
      version: 1,
      status: 'planned',
    });
    await closeDetail(page);
    await expect(card(page, ID.request)).toHaveAttribute('data-status', 'planned');

    // Start an assigned job; alone in its priority it can't move (with the hint).
    d = await openDetail(page, ID.driverOwn);
    await d.getByTestId('job-status-in_progress').tap();
    await expect(status(d)).toHaveAttribute('data-status', 'in_progress');
    await expect(d.getByTestId('job-move-up')).toBeDisabled();
    await expect(d.getByTestId('job-move-down')).toBeDisabled();
    await expect(d.getByTestId('job-move-hint')).toBeVisible();
    await closeDetail(page);
    // The × on its chip takes the machine and the driver off (the whole row).
    const own = card(page, ID.driverOwn);
    await own.getByTestId('job-assignment-remove').tap();
    await expect(own.getByTestId('job-assignment-chip')).toHaveCount(0);
    expect(api.calls('DELETE', `/api/v1/jobs/${ID.driverOwn}/assignments/`)[0]?.path).toMatch(
      /\?version=2$/,
    );
    // The × never opened the detail.
    await expect(page.getByTestId('job-detail')).toHaveCount(0);

    // Move down: the lane's open jobs in the new order; the card swaps within its priority.
    d = await openDetail(page, ID.second);
    await expect(d.getByTestId('job-move-up')).toBeEnabled();
    await d.getByTestId('job-move-down').tap();
    await expect.poll(() => api.calls('POST', '/api/v1/jobs/reorder').length).toBe(1);
    expect(api.calls('POST', '/api/v1/jobs/reorder')[0]?.body).toEqual({
      businessLine: 'spraying',
      jobs: [
        { id: ID.driverOwn, version: 3 },
        { id: ID.request, version: 2 },
        { id: ID.third, version: 1 },
        { id: ID.second, version: 1 },
        { id: ID.extra, version: 1 },
      ],
    });
    // Now last of its priority: Move down is off, Move up on.
    await expect(d.getByTestId('job-move-down')).toBeDisabled();
    await expect(d.getByTestId('job-move-up')).toBeEnabled();
    // Edit opens job-forms' form; its cancel comes back.
    await d.getByTestId('job-edit').tap();
    await expect(page.getByTestId('job-form')).toBeVisible();
    await page.getByTestId('job-form-cancel').tap();
    await expect(page.getByTestId('job-detail')).toHaveAttribute('data-mode', 'view');
    await closeDetail(page);
    const lane = page.locator('[data-testid="jobs-lane"][data-business-line="spraying"]');
    await expect
      .poll(() =>
        lane
          .getByTestId('job-card')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-job-id'))),
      )
      .toEqual([ID.driverOwn, ID.request, ID.third, ID.second, ID.extra]);

    // Cancel with a reason: posted to …/cancel; the card leaves the board, the detail closes.
    d = await openDetail(page, ID.second);
    await d.getByTestId('job-cancel').tap();
    await d.getByTestId('job-cancel-reason').fill('Rained out');
    await d.getByTestId('job-cancel-confirm').tap();
    await expect(page.getByTestId('job-detail')).toHaveCount(0);
    await expect(card(page, ID.second)).toHaveCount(0);
    expect(api.calls('POST', `/api/v1/jobs/${ID.second}/cancel`)[0]?.body).toEqual({
      version: 2,
      reason: 'Rained out',
    });

    // A 409: someone else changed the job; the board says so and shows the current job.
    api.touch(ID.daleHarvest, { title: 'E2E harvest (changed elsewhere)' });
    d = await openDetail(page, ID.daleHarvest);
    await d.getByTestId('job-status-done').tap();
    await expect(d.getByTestId('job-conflict')).toHaveText(new RegExp(JOB_CONFLICT_MESSAGE));
    await expect(d).toContainText('changed elsewhere');
    await expect(status(d)).toHaveAttribute('data-status', 'in_progress');
    await closeDetail(page);
    await expect(card(page, ID.daleHarvest)).toHaveAttribute('data-version', '2');

    // New job: job-forms' form.
    await page.getByTestId('job-new').tap();
    await expect(page.getByTestId('job-form')).toBeVisible();
  } finally {
    await b.context.close();
  }
});

test('a driver gets Start on their own job only; a viewer gets no buttons, no grips, no New job, no drag', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const driver = await openBoard(browser, 'driver');
  try {
    const { page, api } = driver;
    await showJobs(page);
    await expect(page.getByTestId('job-new')).toHaveCount(0);
    await expect(page.getByTestId('job-drag-handle')).toHaveCount(0);
    await expect(page.getByTestId('job-assignment-remove')).toHaveCount(0);
    let d = await openDetail(page, ID.driverOwn);
    await expect(d.getByTestId('job-status-actions').getByRole('button')).toHaveText(['Start']);
    await expect(d.getByTestId('job-cancel')).toHaveCount(0);
    await expect(d.getByTestId('job-move-up')).toHaveCount(0);
    await expect(d.getByTestId('job-edit')).toHaveCount(0);
    await d.getByTestId('job-status-in_progress').tap();
    await expect(d.getByTestId('job-detail-status')).toHaveAttribute('data-status', 'in_progress');
    expect(api.calls('POST', `/api/v1/jobs/${ID.driverOwn}/status`)).toHaveLength(1);
    await closeDetail(page);
    // Someone else's job: nothing to press.
    d = await openDetail(page, ID.daleHarvest);
    await expect(d.getByTestId('job-detail-status')).toBeVisible();
    await expect(d.locator('[data-testid^="job-status-"]')).toHaveCount(0);
  } finally {
    await driver.context.close();
  }

  const viewer = await openBoard(browser, 'viewer');
  try {
    const { page } = viewer;
    await showJobs(page);
    await expect(card(page, ID.request)).toHaveAttribute('data-draggable', 'false');
    await expect(page.getByTestId('job-drag-handle')).toHaveCount(0);
    await expect(page.getByTestId('job-new')).toHaveCount(0);
    await expect(page.getByTestId('job-assignment-remove')).toHaveCount(0);
    // A held finger on a card starts nothing.
    const hold = await holdCard(page, card(page, ID.request));
    await expect(page.getByTestId('job-drag-overlay')).toHaveCount(0);
    await hold.lift(await centerOf(page.locator('[data-testid="chip-machine"]').first()));
    expect(viewer.writes()).toEqual([]);
    const d = await openDetail(page, ID.driverOwn);
    await expect(d.locator('[data-testid^="job-status-"]')).toHaveCount(0);
    await expect(d.getByTestId('job-cancel')).toHaveCount(0);
    await expect(d.getByTestId('job-move-up')).toHaveCount(0);
    await expect(d.getByTestId('job-edit')).toHaveCount(0);
  } finally {
    await viewer.context.close();
  }
});
