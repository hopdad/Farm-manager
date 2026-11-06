/**
 * Slice 2a job-forms (docs/contracts-2a.md §7.3, §11.3): the field panel's Jobs tab and the job
 * form, on the wall (/board) and the phone (/m).
 *
 *  - A viewer opens a field, picks the Jobs tab: the field's open jobs with their status colour
 *    (done ones counted, not listed), no "New job here"; `jobs`/`updated` naming another field
 *    refetches nothing, naming this one shows the new job.
 *  - A manager: "New job here" opens the form with the field and its customer filled in; every
 *    input of a requested job phoned in (window, crop year, acres by hand, amount, priority,
 *    notes, products with rate, unit and supplied-by, who asked) goes into the POST exactly; the
 *    list shows the new job. Edit sends only what changed with the version; a 409 shows
 *    JOB_CONFLICT_MESSAGE and the current job with the edit on top, and Save tries again.
 *
 * GET/POST/PATCH /api/v1/jobs** are jobs-api's: they are mocked here with page.route (contracts
 * §2; the integrator runs this unmocked after the merge, see the report). GET /api/v1/job-options
 * (job-forms') is real: the form picks the demo seed's products and the spec's own field and
 * customer. Realtime is the e2e double (installFakeRealtime); the tab finds the mode through the
 * real HEAD /api/v1/job-options because the mocked snapshot carries no realtime headers.
 *
 * The spec seeds one field per project in an empty corner south-east of the demo farm (lat 41.69
 * wall / 41.675 phone, lng -83.70) and a throwaway customer (source 'e2e', 'tmp:'), and removes
 * them afterwards.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type Page, type Route, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { demoId } from '../src/domain/ids';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import {
  type CreateJobBody,
  JOB_CONFLICT_MESSAGE,
  type JobView,
  type UpdateJobBody,
} from '../src/ui/work/contract';
import { makeJobView, makeSnapshot } from '../src/ui/work/forms/fixtures';
import { JOB_STATUS_COLORS } from '../src/ui/work/style';
import { E2E_SOURCE, signInAs } from './support/auth';
import {
  installFakeRealtime,
  mapIdle,
  mapPathFor,
  revealInFreeMap,
  WEBGL_ARGS,
  waitForMap,
} from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'default' });

const PROPAGATION_MS = 2_000;
const SIDE_M = 400;
const tag = randomBytes(3).toString('hex');

interface Seeded {
  fieldId: string;
  farmId: string;
  name: string;
  center: { lng: number; lat: number };
  customerId: string;
  customerName: string;
}

let pool: Pool;
let seeded: Seeded;
const isPhone = () => test.info().project.name === 'phone';

test.beforeAll(async () => {
  const project = test.info().project.name;
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  await pool.query('delete from farm.fields where name like $1', [`E2E Jobs ${project} %`]);
  const customerName = `E2E Customer ${project} ${tag}`;
  const c = await pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles, source, source_id)
     values ('org', $1, '{customer}', $2, $3) returning id`,
    [customerName, E2E_SOURCE, `tmp:jobs-${project}-${tag}`],
  );
  const lat = project === 'phone' ? 41.675 : 41.69;
  const lng = -83.7;
  const geom = squareMultiPolygon(lng, lat, SIDE_M);
  const name = `E2E Jobs ${project} ${tag}`;
  const ids = await insertField(createDb(pool), { name, geom, tenure: 'custom' });
  await pool.query('update farm.farms set client_party_id = $2 where id = $1', [
    ids.farmId,
    c.rows[0]?.id,
  ]);
  const ring = geom.coordinates[0]?.[0] ?? [];
  const [[w = 0, s = 0] = [], , [e = 0, n = 0] = []] = ring;
  seeded = {
    fieldId: ids.fieldId,
    farmId: ids.farmId,
    name,
    center: { lng: (w + e) / 2, lat: (s + n) / 2 },
    customerId: c.rows[0]?.id as string,
    customerName,
  };
});

test.afterAll(async () => {
  if (seeded) {
    await pool.query('delete from farm.fields where id = $1', [seeded.fieldId]);
    await pool.query('delete from farm.farms where id = $1', [seeded.farmId]);
    await pool.query('delete from farm.parties where id = $1', [seeded.customerId]);
  }
  await pool?.end();
});

// ---------------------------------------------------------------------------------------------
// The mocked jobs API (jobs-api's routes, until the merge)
// ---------------------------------------------------------------------------------------------

interface MockApi {
  jobs: JobView[];
  gets: number;
  posts: CreateJobBody[];
  patches: UpdateJobBody[];
  /** The next PATCH answers 409 with this job (and it becomes the current one). */
  conflictWith: JobView | null;
}

const PRODUCT_NAMES: Record<string, { name: string; kind: 'chemical' | 'fertilizer' }> = {
  [demoId('product-glyphosate')]: { name: 'Glyphosate 5.5 (demo)', kind: 'chemical' },
  [demoId('product-uan28')]: { name: '28% UAN', kind: 'fertilizer' },
};

function onField(over: Partial<JobView> = {}): JobView {
  return makeJobView({
    id: randomUUID(),
    field: { id: seeded.fieldId, name: seeded.name, farmName: 'Home farm', boundaryAcres: 39.5 },
    customer: { id: seeded.customerId, name: seeded.customerName },
    products: [],
    ...over,
  });
}

function jobFromCreate(body: CreateJobBody): JobView {
  return onField({
    version: 1,
    kind: body.kind,
    businessLine: body.businessLine ?? 'spraying',
    status: body.status ?? 'planned',
    title: body.title ?? null,
    summary: body.title ?? `Spray · ${seeded.name}`,
    window: body.window ?? null,
    cropYear: body.cropYear ?? null,
    plannedAcres: body.plannedAcres ?? 39.5,
    plannedAcresByHand: body.plannedAcres !== undefined,
    plannedQty: body.plannedQty ?? null,
    plannedUnit: body.plannedUnit ?? null,
    priority: body.priority ?? 3,
    notes: body.notes ?? null,
    request: body.request
      ? {
          channel: body.request.channel,
          partyId: body.request.partyId ?? null,
          name: body.request.name ?? null,
          phone: body.request.phone ?? null,
          viaLink: false,
        }
      : null,
    products: (body.products ?? []).map((p) => ({
      id: randomUUID(),
      productId: p.productId,
      name: PRODUCT_NAMES[p.productId]?.name ?? 'Product',
      kind: PRODUCT_NAMES[p.productId]?.kind ?? 'chemical',
      rate: p.rate ?? null,
      unit: p.unit ?? null,
      suppliedBy: p.suppliedBy,
      restrictedUse: false,
      epaRegNo: null,
    })),
  });
}

async function mockJobsApi(page: Page, api: MockApi, viewer: { canPlan: boolean }): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/jobs',
    async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        api.gets++;
        const fieldId = new URL(req.url()).searchParams.get('fieldId');
        const jobs = api.jobs.filter((j) => !fieldId || j.field?.id === fieldId);
        await route.fulfill({
          json: makeSnapshot(jobs, { role: viewer.canPlan ? 'manager' : 'viewer', ...viewer }),
          headers: { 'cache-control': 'no-store' },
        });
        return;
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON() as CreateJobBody;
        api.posts.push(body);
        const job = jobFromCreate(body);
        api.jobs.push(job);
        await route.fulfill({ status: 201, json: { job } });
        return;
      }
      await route.fulfill({ status: 405, json: { error: 'method' } });
    },
  );
  await page.route(
    (url) => /^\/api\/v1\/jobs\/[0-9a-f-]{36}$/.test(url.pathname),
    async (route: Route) => {
      const req = route.request();
      const id = new URL(req.url()).pathname.split('/').at(-1);
      const i = api.jobs.findIndex((j) => j.id === id);
      const current = api.jobs[i];
      if (req.method() !== 'PATCH' || !current) {
        await route.fulfill({ status: 404, json: { error: 'job not found' } });
        return;
      }
      const body = req.postDataJSON() as UpdateJobBody;
      api.patches.push(body);
      if (api.conflictWith) {
        api.jobs[i] = api.conflictWith;
        const job = api.conflictWith;
        api.conflictWith = null;
        await route.fulfill({ status: 409, json: { error: JOB_CONFLICT_MESSAGE, job } });
        return;
      }
      if (body.version !== current.version) {
        await route.fulfill({ status: 409, json: { error: JOB_CONFLICT_MESSAGE, job: current } });
        return;
      }
      const { version: _v, ...changes } = body;
      const next: JobView = {
        ...current,
        ...(changes.title !== undefined
          ? { title: changes.title, summary: changes.title ?? current.summary }
          : {}),
        ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
        ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
        version: current.version + 1,
      };
      api.jobs[i] = next;
      await route.fulfill({ json: { job: next } });
    },
  );
}

const newApi = (jobs: JobView[]): MockApi => ({
  jobs,
  gets: 0,
  posts: [],
  patches: [],
  conflictWith: null,
});

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------

/** Open the board (wall) or /m (phone) on the seeded field, tap it, show the Jobs tab. */
async function openJobsTab(page: Page): Promise<void> {
  await page.goto(mapPathFor(test.info()));
  await waitForMap(page, 90_000);
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 15, bearing: 0 }),
    seeded.center,
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
  await revealInFreeMap(page, seeded.center);
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat), seeded.center);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
  const panel = page.getByTestId('field-panel');
  await expect(panel).toHaveAttribute('data-field-id', seeded.fieldId);
  await expect(panel).toHaveAttribute('data-state', 'ready');
  if (isPhone() && (await panel.getAttribute('data-snap')) !== 'full') {
    await page.getByTestId('field-sheet-handle').click();
    await expect(panel).toHaveAttribute('data-snap', 'full');
  }
  await page.getByTestId('field-tab-jobs').click();
  await expect(page.getByTestId('field-tab-jobs')).toHaveAttribute('aria-selected', 'true');
}

const rows = (page: Page) => page.getByTestId('field-job-row');

test('a viewer sees the field’s open jobs by status and they follow jobs/updated for the field', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(context, 'viewer');
  await installFakeRealtime(page);
  const assigned = onField({
    status: 'assigned',
    summary: 'Spray · burndown',
    assignments: [
      {
        id: randomUUID(),
        role: 'operator',
        machine: {
          id: randomUUID(),
          unitNo: 'SP2',
          kind: 'sprayer',
          status: 'active',
          workPlanCapable: false,
        },
        person: { partyId: randomUUID(), name: 'Dale Mercer', initials: 'DM' },
        plannedFor: null,
        alsoOn: [],
      },
    ],
  });
  const requested = onField({
    kind: 'haul',
    businessLine: 'trucking',
    status: 'requested',
    summary: 'Haul · beans',
  });
  const done = onField({ status: 'done', summary: 'Scout · done today' });
  const api = newApi([assigned, requested, done]);
  await mockJobsApi(page, api, { canPlan: false });
  await openJobsTab(page);

  const list = page.getByTestId('field-jobs');
  await expect(list).toHaveAttribute('data-state', 'ready');
  await expect(rows(page)).toHaveCount(2);
  await expect(list).toContainText('2 open jobs · 1 done today');
  const first = page.locator(`[data-testid="field-job-row"][data-job-id="${assigned.id}"]`);
  await expect(first).toHaveAttribute('data-status', 'assigned');
  await expect(first.getByTestId('field-job-who')).toHaveText('SP2 · Dale Mercer');
  await expect(first.getByTestId('field-job-status')).toHaveCSS(
    'background-color',
    hexToRgb(JOB_STATUS_COLORS.assigned.fill),
  );
  await expect(
    page.locator(`[data-testid="field-job-row"][data-job-id="${requested.id}"]`),
  ).toHaveAttribute('data-status', 'requested');
  // A viewer plans nothing.
  await expect(page.getByTestId('field-new-job')).toHaveCount(0);
  await expect(page.getByTestId('field-job-edit')).toHaveCount(0);

  // The tab subscribed (it found the realtime mode through HEAD /api/v1/job-options).
  await expect.poll(() => api.gets, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const settled = api.gets;
  const emit = (fieldIds: string[], seq: number) =>
    page.evaluate(
      ({ fieldIds, seq }) =>
        window.__fleetEmit?.('jobs', {
          event: 'updated',
          payload: { jobIds: [], fieldIds, machineIds: [], partyIds: [] },
          seq,
        }),
      { fieldIds, seq },
    );
  // Another field changed: no refetch.
  await emit([randomUUID()], 100);
  await page.waitForTimeout(600);
  expect(api.gets).toBe(settled);
  // This field changed (another screen added a job): it shows within 2 s.
  const planned = onField({ status: 'planned', summary: 'Spray · from the other screen' });
  api.jobs.push(planned);
  const at = Date.now();
  await emit([seeded.fieldId], 101);
  await expect(
    page.locator(`[data-testid="field-job-row"][data-job-id="${planned.id}"]`),
  ).toBeVisible({
    timeout: PROPAGATION_MS,
  });
  const took = Date.now() - at;
  console.log(`[m2a-forms ${test.info().project.name}] jobs/updated → Jobs tab took ${took} ms`);
  expect(took).toBeLessThan(PROPAGATION_MS);
  await expect(rows(page)).toHaveCount(3);
});

test('a manager adds a requested job with every field, then edits it through a 409', async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  await signInAs(context, 'manager');
  await installFakeRealtime(page);
  const existing = onField({
    version: 4,
    status: 'planned',
    notes: 'old notes',
    summary: 'Spray · existing',
  });
  const api = newApi([existing]);
  await mockJobsApi(page, api, { canPlan: true });
  await openJobsTab(page);
  await expect(rows(page)).toHaveCount(1);

  // New job here: the form, with the field and its customer filled in.
  await page.getByTestId('field-new-job').click();
  const form = page.getByTestId('job-form');
  await expect(form).toHaveAttribute('data-mode', 'new');
  await expect(form).toHaveAttribute('data-state', 'ready');
  await expect(form.getByTestId('job-form-field')).toHaveValue(seeded.fieldId);
  await expect(form.getByTestId('job-form-customer')).toHaveValue(seeded.customerId);
  await expect(form.getByTestId('job-form-kind')).toHaveValue('spray');
  await expect(form.getByTestId('job-form-business-line')).toHaveValue('spraying');

  await form.getByTestId('job-form-status').selectOption('requested');
  await form.getByTestId('job-form-request-channel').selectOption('phone');
  await form.getByTestId('job-form-requester-name').fill('Gail Pressler');
  await form.getByTestId('job-form-requester-phone').fill('(517) 555-0100');
  await form.getByTestId('job-form-title').fill('Burndown before wheat');
  await form.getByTestId('job-form-priority').selectOption('2');
  await form.getByTestId('job-form-window-from').fill('2026-11-20T08:00');
  await form.getByTestId('job-form-window-to').fill('2026-11-21T17:00');
  const years = await form
    .getByTestId('job-form-crop-year')
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  const year = years.at(-1) as string;
  await form.getByTestId('job-form-crop-year').selectOption(year);
  await form.getByTestId('job-form-planned-acres').fill('35');
  await form.getByTestId('job-form-planned-qty').fill('2');
  await form.getByTestId('job-form-planned-unit').selectOption('loads');
  await form.getByTestId('job-form-notes').fill('Gate code 1234');
  await form.getByTestId('job-form-product-add').selectOption({ label: 'Glyphosate 5.5 (demo)' });
  await form.getByTestId('job-form-product-add').selectOption({ label: '28% UAN' });
  const lines = form.getByTestId('job-form-product');
  await expect(lines).toHaveCount(2);
  await lines.nth(0).getByTestId('job-form-product-rate').fill('32');
  await lines.nth(0).getByTestId('job-form-product-unit').selectOption('floz_ac');
  await lines.nth(1).getByTestId('job-form-product-supplied-by').selectOption('customer');
  await expect(lines.nth(1).getByTestId('job-form-product-unit')).toHaveValue('gal_ac');
  await lines.nth(1).getByTestId('job-form-product-unit').selectOption('');
  await form.getByTestId('job-form-save').click();

  await expect(page.getByTestId('job-form')).toHaveCount(0);
  await expect(page.getByTestId('field-job-saved')).toContainText('Burndown before wheat');
  expect(api.posts).toEqual([
    {
      kind: 'spray',
      businessLine: 'spraying',
      status: 'requested',
      title: 'Burndown before wheat',
      fieldId: seeded.fieldId,
      customerPartyId: seeded.customerId,
      window: { from: '2026-11-20T08:00:00-05:00', to: '2026-11-21T17:00:00-05:00' },
      cropYear: Number(year),
      plannedAcres: 35,
      plannedQty: 2,
      plannedUnit: 'loads',
      priority: 2,
      notes: 'Gate code 1234',
      request: { channel: 'phone', partyId: null, name: 'Gail Pressler', phone: '(517) 555-0100' },
      products: [
        { productId: demoId('product-glyphosate'), rate: 32, unit: 'floz_ac', suppliedBy: 'us' },
        { productId: demoId('product-uan28'), rate: null, unit: null, suppliedBy: 'customer' },
      ],
    },
  ]);
  const created = api.jobs.at(-1) as JobView;
  await expect(
    page.locator(`[data-testid="field-job-row"][data-job-id="${created.id}"]`),
  ).toHaveAttribute('data-status', 'requested');
  await expect(rows(page)).toHaveCount(2);

  // Edit the existing job; another screen saves first: 409, the current job with my notes on top.
  const row = page.locator(`[data-testid="field-job-row"][data-job-id="${existing.id}"]`);
  await row.getByTestId('field-job-edit').click();
  const edit = page.getByTestId('job-form');
  await expect(edit).toHaveAttribute('data-mode', 'edit');
  await expect(edit).toHaveAttribute('data-state', 'ready');
  await expect(edit.getByTestId('job-form-notes')).toHaveValue('old notes');
  await edit.getByTestId('job-form-notes').fill('my notes');
  api.conflictWith = {
    ...existing,
    version: 5,
    title: 'Changed on the wall',
    summary: 'Changed on the wall',
  };
  await edit.getByTestId('job-form-save').click();
  await expect(edit.getByTestId('job-form-conflict')).toContainText(JOB_CONFLICT_MESSAGE);
  await expect(edit.getByTestId('job-form-title')).toHaveValue('Changed on the wall');
  await expect(edit.getByTestId('job-form-notes')).toHaveValue('my notes');
  await edit.getByTestId('job-form-save').click();
  await expect(page.getByTestId('job-form')).toHaveCount(0);
  expect(api.patches).toEqual([
    { version: 4, notes: 'my notes' },
    { version: 5, notes: 'my notes' },
  ]);
  await expect(page.getByTestId('field-job-saved')).toContainText('Changed on the wall');
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
