/**
 * Slice 2a done-when (docs/contracts-2a.md §11.2, plan §6 2a): with the wall and a phone side by
 * side, drag a spray job onto a field, then onto Sprayer 2 (unit SP2) and an operator; the other
 * screen updates in under 2 s. Under `next start` (`pnpm pilot`), two browser contexts driven
 * from the `wall` project, trusted touch through CDP (`Input.dispatchTouchEvent`,
 * e2e/support/drag.ts), in BOTH directions:
 *
 *   1. the wall (a manager: what Amy's PIN on the wall amounts to for the API) drags the spec's
 *      own requested spray job onto an e2e field, then onto SP2, then onto Dale; the phone (a
 *      viewer) shows the card on that field, then the SP2 chip, then "SP2 · Dale Mercer";
 *   2. the phone (a manager) drags a second e2e job onto another e2e field, SP1 and Luis; the
 *      wall (a viewer) follows the same way.
 *
 * Each step's `took` runs from the drop's `releasedAt` to the other screen showing it, is
 * logged and annotated, and must be < 2000 ms (as e2e/field-panel.spec.ts does for notes).
 *
 * The spec's jobs are its own (contracts-2a §8): source 'e2e', deterministic ids, source_id
 * `e2e:m2a-board:<direction>`, requested, no field, NO window (a null window never overlaps a
 * demo job, so no `double_booked`), removed afterwards; the e2e fields sit in an empty corner
 * south of the demo farm and are removed afterwards.
 *
 * MOCKS (until the merge; contracts-2a §11.2): `API_MODE` below.
 *   - 'mock': the job routes (/api/v1/jobs/**, /api/v1/crew) are answered by the in-memory
 *     stand-in of src/ui/work/board/testkit.ts (page.route), which reads the REAL demo machines,
 *     crew and the spec's fields from the e2e database, and every write it answers is handed to
 *     the other screen as `jobs`/`updated` through the e2e realtime double
 *     (installFakeRealtime + window.__fleetEmit), as the jobs triggers would publish it.
 *   - 'real': nothing is mocked: jobs-api's routes, the jobs triggers, the SSE realtime; the
 *     jobs are inserted into farm.jobs directly.
 *   - 'auto' (the default): 'mock' while GET /api/v1/jobs still answers the foundation stub's
 *     501, else 'real'. THE INTEGRATOR sets 'real' after the merge, so a missing route fails the
 *     spec instead of silently mocking it.
 */
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
import { deterministicId } from '../src/domain/ids';
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
import { E2E_SOURCE, signInAs } from './support/auth';
import { centerOf, mapPoint, type Pt, touchDrag } from './support/drag';
import {
  installFakeRealtime,
  mapIdle,
  revealInFreeMap,
  WEBGL_ARGS,
  waitForMap,
} from './support/map';

/** 'auto' | 'mock' | 'real': see the header. The integrator sets 'real' after the merge. */
const API_MODE = 'auto' as 'auto' | 'mock' | 'real';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

/** Plan §6 2a: the other screen updates in under 2 s. */
const PROPAGATION_MS = 2_000;
const BASE_URL = getE2eSettings().baseURL;
const SPEC = 'm2a-board';
const SIDE_M = 400;
/**
 * The phone's hold before the finger moves (the TouchSensor needs 200 ms; the jobs sheet then
 * drops to peek): long enough for the sheet to be down on a busy machine. The clock starts at
 * the lift, so the hold never counts towards `took`.
 */
const PHONE_HOLD_MS = 600;

interface Seeded {
  id: string;
  farmId: string;
  name: string;
  center: { lng: number; lat: number };
}

const JOBS = {
  wall: {
    id: deterministicId(E2E_SOURCE, `job:${SPEC}:wall`),
    title: 'E2E spray (the wall drags)',
  },
  phone: {
    id: deterministicId(E2E_SOURCE, `job:${SPEC}:phone`),
    title: 'E2E spray (the phone drags)',
  },
} as const;

let pool: Pool;
const fields: Seeded[] = [];
let mode: 'mock' | 'real' = 'mock';

const wallOptions = (): Parameters<Browser['newContext']>[0] => ({
  ...devices['Desktop Chrome'],
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  hasTouch: true,
  baseURL: BASE_URL,
});
const phoneOptions = (): Parameters<Browser['newContext']>[0] => ({
  ...devices['Pixel 7'],
  baseURL: BASE_URL,
});

test.beforeAll(async () => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
});

/** The spec's jobs gone and its two fields seeded (once per worker; the wall project only). */
async function ensureFields(): Promise<void> {
  if (fields.length) return;
  // Leftovers of an interrupted run.
  await pool.query(`delete from farm.jobs where id = any($1::uuid[])`, [
    [JOBS.wall.id, JOBS.phone.id],
  ]);
  await pool.query(
    `delete from farm.farms fa where exists (
       select 1 from farm.fields f where f.farm_id = fa.id and f.name like $1)`,
    [`E2E ${SPEC} %`],
  );
  const db = createDb(pool);
  // Two 400 m squares in an empty corner south of the demo farm (other specs use other rows).
  for (const [i, lng] of [-83.705, -83.695].entries()) {
    const lat = 41.69;
    const name = `E2E ${SPEC} ${i + 1}`;
    const geom = squareMultiPolygon(lng, lat, SIDE_M);
    const ids = await insertField(db, { name, geom, tenure: 'custom' });
    // (lng, lat) is the square's south-west corner: drop in the middle.
    const [[w = 0, s = 0] = [], , [e = 0, n = 0] = []] = geom.coordinates[0]?.[0] ?? [];
    fields.push({
      id: ids.fieldId,
      farmId: ids.farmId,
      name,
      center: { lng: (w + e) / 2, lat: (s + n) / 2 },
    });
  }
}

test.afterAll(async () => {
  await pool?.query(`delete from farm.jobs where id = any($1::uuid[])`, [
    [JOBS.wall.id, JOBS.phone.id],
  ]);
  for (const f of fields) {
    await pool?.query('delete from farm.fields where id = $1', [f.id]);
    await pool?.query('delete from farm.farms where id = $1', [f.farmId]);
  }
  fields.length = 0;
  await pool?.end();
});

const field = (i: number): Seeded => {
  const f = fields[i];
  if (!f) throw new Error(`no seeded field ${i}`);
  return f;
};

/** 'mock' while the jobs routes are the foundation's 501 stubs (API_MODE 'auto'). */
async function resolveMode(context: BrowserContext): Promise<'mock' | 'real'> {
  if (API_MODE !== 'auto') return API_MODE;
  const res = await context.request.get('/api/v1/jobs');
  return res.status() === 501 ? 'mock' : 'real';
}

interface Screen {
  context: BrowserContext;
  page: Page;
  viewer: MockViewer;
}

/**
 * The jobs API for both screens: the stand-in (mock) or the real routes with the job seeded in
 * farm.jobs (real). Returns the job seeder.
 */
async function wireJobsApi(screens: Screen[]): Promise<{
  seed(job: { id: string; title: string }): Promise<void>;
  api: MockJobsApi | null;
}> {
  if (mode === 'real') {
    return {
      api: null,
      async seed(job) {
        await pool.query(
          `insert into farm.jobs (id, kind, business_line, status, priority, title, source, source_id)
           values ($1, 'spray', 'spraying', 'requested', 1, $2, $3, $4)
           on conflict (id) do nothing`,
          [
            job.id,
            job.title,
            E2E_SOURCE,
            `e2e:${SPEC}:${job.id === JOBS.wall.id ? 'wall' : 'phone'}`,
          ],
        );
      },
    };
  }
  const api = new MockJobsApi(createSqlWorld((text, values) => pool.query(text, values)));
  let seq = 0;
  // What the jobs triggers publish on commit, delivered to every screen's realtime double.
  api.onChange((payload) => {
    seq += 1;
    for (const s of screens) {
      void s.page
        .evaluate(
          ({ payload, seq }) => window.__fleetEmit?.('jobs', { event: 'updated', payload, seq }),
          { payload, seq },
        )
        .catch(() => {});
    }
  });
  for (const s of screens) {
    await installFakeRealtime(s.page);
    await s.context.route(isMockedJobsUrl, mockRouteHandler(api, s.viewer));
  }
  return {
    api,
    async seed(job) {
      api.put(
        makeJobView({
          id: job.id,
          kind: 'spray',
          businessLine: 'spraying',
          status: 'requested',
          priority: 1,
          title: job.title,
          sortKey: job.id === JOBS.wall.id ? 10 : 20,
        }),
      );
    },
  };
}

const card = (page: Page, jobId: string) =>
  page.locator(`[data-testid="job-card"][data-job-id="${jobId}"]`);

/** Centre the map on `f` at z15 and wait until its tile answers queryRenderedFeatures. */
async function showField(page: Page, f: Seeded): Promise<void> {
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 15, bearing: 0 }),
    f.center,
  );
  await mapIdle(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['fields-fill'] })
              .map((x) => String(x.properties.id)) ?? [],
        ),
      { timeout: 20_000, message: `the e2e field ${f.name} drawn` },
    )
    .toContain(f.id);
}

/** Scroll a chip into the middle of its tray row (rows scroll sideways on their own). */
async function bringChipIntoView(chip: ReturnType<Page['locator']>): Promise<void> {
  await chip.evaluate((el) => {
    const row = el.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    row.scrollLeft += c.left - r.left - (r.width - c.width) / 2;
  });
}

/**
 * Phones: where a chip WILL be once the drag has begun (the jobs sheet drops to peek when a
 * drag starts, and the tray is pinned at its top), as the person sees it move and follows it.
 */
async function chipAtPeek(page: Page, chip: ReturnType<Page['locator']>): Promise<Pt> {
  const sheet = await page.getByTestId('jobs-sheet').boundingBox();
  const box = await chip.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  if (!sheet || !box) throw new Error('no sheet or chip');
  const peekTop = vh - snapHeights(vh).peek;
  return { x: box.x + box.width / 2, y: peekTop + (box.y - sheet.y) + box.height / 2 };
}

/** Wait for the sheet's snap height to settle (its CSS transition). */
async function sheetSettled(page: Page, snap: 'peek' | 'half' | 'full'): Promise<void> {
  const sheet = page.getByTestId('jobs-sheet');
  await expect(sheet).toHaveAttribute('data-snap', snap);
  const h = snapHeights(page.viewportSize()?.height ?? 0)[snap];
  await expect.poll(async () => Math.round((await sheet.boundingBox())?.height ?? 0)).toBe(h);
}

/** Stop the clock at `releasedAt` when `check` passes on the other screen; log and assert. */
async function propagated(
  label: string,
  releasedAt: number,
  check: () => Promise<void>,
): Promise<void> {
  await check();
  const took = Date.now() - releasedAt;
  test.info().annotations.push({ type: `${label} (ms, ${mode})`, description: String(took) });
  console.log(`[${SPEC} ${mode}] ${label}: took ${took} ms`);
  expect(took, label).toBeLessThan(PROPAGATION_MS);
}

async function openBoard(page: Page, path: '/board' | '/m'): Promise<void> {
  await page.goto(path);
  // Two maps drawn in software (SwiftShader), the wall at 4K: slow to load, not to react.
  await waitForMap(page, 90_000);
}

async function openJobsSheet(page: Page): Promise<void> {
  await page.getByTestId('jobs-pill').tap();
  await expect(page.getByTestId('jobs-sheet')).toBeVisible();
  await sheetSettled(page, 'half');
}

test.describe('done-when: a spray job onto a field, SP2 and an operator; the other screen in < 2 s', () => {
  test('the wall drags (trusted touch), the phone watches', async ({ browser }, info) => {
    test.skip(info.project.name !== 'wall', 'its own wall and phone contexts: run once');
    test.setTimeout(300_000);
    await ensureFields();
    const wallCtx = await browser.newContext(wallOptions());
    const phoneCtx = await browser.newContext(phoneOptions());
    try {
      await signInAs(wallCtx, 'manager');
      await signInAs(phoneCtx, 'viewer');
      mode = await resolveMode(wallCtx);
      test.info().annotations.push({ type: 'api mode', description: mode });
      const wall: Screen = {
        context: wallCtx,
        page: await wallCtx.newPage(),
        viewer: { role: 'manager', partyId: deterministicId(E2E_SOURCE, 'party:manager') },
      };
      const phone: Screen = {
        context: phoneCtx,
        page: await phoneCtx.newPage(),
        viewer: { role: 'viewer', partyId: null },
      };
      const jobs = await wireJobsApi([wall, phone]);
      await jobs.seed(JOBS.wall);
      const f = field(0);

      await openBoard(wall.page, '/board');
      await openBoard(phone.page, '/m');
      const wallCard = card(wall.page, JOBS.wall.id);
      await expect(wallCard).toBeVisible({ timeout: 20_000 });
      await expect(wallCard).toHaveAttribute('data-status', 'requested');
      await expect(wallCard).toHaveAttribute('data-draggable', 'true');
      await openJobsSheet(phone.page);
      const phoneCard = card(phone.page, JOBS.wall.id);
      await expect(phoneCard).toBeVisible();
      await expect(phoneCard).toHaveAttribute('data-field-id', '');

      const cdp = await wallCtx.newCDPSession(wall.page);
      // 1. Onto the field.
      await showField(wall.page, f);
      await revealInFreeMap(wall.page, f.center);
      await wallCard.scrollIntoViewIfNeeded();
      const onField = await touchDrag(
        wall.page,
        await centerOf(wallCard),
        await mapPoint(wall.page, f.center),
        {
          cdp,
        },
      );
      await propagated('field', onField.releasedAt, () =>
        expect(phoneCard).toHaveAttribute('data-field-id', f.id, { timeout: PROPAGATION_MS }),
      );
      await expect(wallCard).toHaveAttribute('data-field-id', f.id);
      // A drop never opens the field panel.
      await expect(wall.page.getByTestId('field-panel')).toHaveCount(0);

      // 2. Onto SP2 (Sprayer 2, a Samsara-gatewayed RoGator: no Deere badge).
      const sp2 = wall.page.locator('[data-testid="chip-machine"][data-unit="SP2"]');
      await expect(sp2).toHaveAttribute('data-work-plan', 'false');
      const sp2Id = (await sp2.getAttribute('data-machine-id')) as string;
      await bringChipIntoView(sp2);
      const onSp2 = await touchDrag(wall.page, await centerOf(wallCard), await centerOf(sp2), {
        cdp,
      });
      const phoneChip = phoneCard.locator(
        `[data-testid="job-assignment-chip"][data-machine-id="${sp2Id}"]`,
      );
      await propagated('SP2', onSp2.releasedAt, () =>
        expect(phoneChip).toContainText('SP2', { timeout: PROPAGATION_MS }),
      );

      // 3. Onto an operator: the same row, "SP2 · Dale Mercer".
      const dale = wall.page.locator('[data-testid="chip-person"][aria-label="Dale Mercer"]');
      const daleId = (await dale.getAttribute('data-party-id')) as string;
      await bringChipIntoView(dale);
      const onDale = await touchDrag(wall.page, await centerOf(wallCard), await centerOf(dale), {
        cdp,
      });
      await propagated('SP2 · Dale Mercer', onDale.releasedAt, () =>
        expect(phoneChip.getByTestId('job-assignment-label')).toHaveText('SP2 · Dale Mercer', {
          timeout: PROPAGATION_MS,
        }),
      );
      await expect(phoneChip).toHaveAttribute('data-party-id', daleId);
      await expect(phoneCard.getByTestId('job-assignment-chip')).toHaveCount(1);
      // A field and someone on it: the request is accepted by assigning it.
      await expect(phoneCard).toHaveAttribute('data-status', 'assigned');
      await expect(wallCard.getByTestId('job-assignment-label')).toHaveText('SP2 · Dale Mercer');
      // No window: never double-booked against the demo's jobs.
      await expect(phoneCard.locator('[data-flag="double_booked"]')).toHaveCount(0);
      await cdp.detach();
    } finally {
      await wallCtx.close();
      await phoneCtx.close();
    }
  });

  test('the phone drags (trusted touch), the wall watches', async ({ browser }, info) => {
    test.skip(info.project.name !== 'wall', 'its own wall and phone contexts: run once');
    test.setTimeout(300_000);
    await ensureFields();
    const wallCtx = await browser.newContext(wallOptions());
    const phoneCtx = await browser.newContext(phoneOptions());
    try {
      await signInAs(wallCtx, 'viewer');
      await signInAs(phoneCtx, 'manager');
      mode = await resolveMode(phoneCtx);
      test.info().annotations.push({ type: 'api mode', description: mode });
      const phone: Screen = {
        context: phoneCtx,
        page: await phoneCtx.newPage(),
        viewer: { role: 'manager', partyId: deterministicId(E2E_SOURCE, 'party:manager') },
      };
      const wall: Screen = {
        context: wallCtx,
        page: await wallCtx.newPage(),
        viewer: { role: 'viewer', partyId: null },
      };
      const jobs = await wireJobsApi([phone, wall]);
      await jobs.seed(JOBS.phone);
      const f = field(1);

      await openBoard(wall.page, '/board');
      await openBoard(phone.page, '/m');
      const wallCard = card(wall.page, JOBS.phone.id);
      await expect(wallCard).toBeVisible({ timeout: 20_000 });
      await expect(wallCard).toHaveAttribute('data-draggable', 'false');

      await showField(phone.page, f);
      await openJobsSheet(phone.page);
      const phoneCard = card(phone.page, JOBS.phone.id);
      await phoneCard.scrollIntoViewIfNeeded();
      await expect(phoneCard).toBeVisible();
      const cdp = await phoneCtx.newCDPSession(phone.page);

      // 1. Onto the field: the sheet drops to peek as the drag starts, so the map is reachable.
      const target = await mapPoint(phone.page, f.center);
      // A longer hold on the phone: the sheet is at peek before the finger moves on.
      const onField = await touchDrag(phone.page, await centerOf(phoneCard), target, {
        cdp,
        holdMs: PHONE_HOLD_MS,
      });
      await propagated('field', onField.releasedAt, () =>
        expect(wallCard).toHaveAttribute('data-field-id', f.id, { timeout: PROPAGATION_MS }),
      );
      await expect(phone.page.getByTestId('field-panel')).toHaveCount(0);
      // Back where it was once the card is down.
      await sheetSettled(phone.page, 'half');

      // 2. Onto SP1 (a Deere sprayer: the card shows the Deere badge on a spray job).
      const sp1 = phone.page.locator('[data-testid="chip-machine"][data-unit="SP1"]');
      const sp1Id = (await sp1.getAttribute('data-machine-id')) as string;
      await bringChipIntoView(sp1);
      await phoneCard.scrollIntoViewIfNeeded();
      const onSp1 = await touchDrag(
        phone.page,
        await centerOf(phoneCard),
        await chipAtPeek(phone.page, sp1),
        { cdp, holdMs: PHONE_HOLD_MS },
      );
      const wallChip = wallCard.locator(
        `[data-testid="job-assignment-chip"][data-machine-id="${sp1Id}"]`,
      );
      await propagated('SP1', onSp1.releasedAt, () =>
        expect(wallChip).toContainText('SP1', { timeout: PROPAGATION_MS }),
      );
      await expect(wallChip).toContainText('Deere');
      await sheetSettled(phone.page, 'half');

      // 3. Onto an operator: "SP1 · Luis Ortega".
      const luis = phone.page.locator('[data-testid="chip-person"][aria-label="Luis Ortega"]');
      await bringChipIntoView(luis);
      await phoneCard.scrollIntoViewIfNeeded();
      const onLuis = await touchDrag(
        phone.page,
        await centerOf(phoneCard),
        await chipAtPeek(phone.page, luis),
        { cdp, holdMs: PHONE_HOLD_MS },
      );
      await propagated('SP1 · Luis Ortega', onLuis.releasedAt, () =>
        expect(wallChip.getByTestId('job-assignment-label')).toHaveText('SP1 · Luis Ortega', {
          timeout: PROPAGATION_MS,
        }),
      );
      await expect(wallCard).toHaveAttribute('data-status', 'assigned');
      await expect(phoneCard.getByTestId('job-assignment-label')).toHaveText('SP1 · Luis Ortega');
      await cdp.detach();
    } finally {
      await wallCtx.close();
      await phoneCtx.close();
    }
  });
});
