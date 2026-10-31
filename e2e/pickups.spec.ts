/**
 * The pickups (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.8.3): PU1 (Ford F-250, Ford
 * Pro) and PU2 (Ram 2500, Stellantis) ride on Samsara's feeds: on the wall's map as pickups (their
 * own icon), fresh on their 30 s carmaker grid under the demo thresholds, with engine hours and
 * odometer NULL (their routes don't report them: the panel's "not reported" comes with fleet-faults'
 * row text); fleet.vehicles sets their kind from the `Pickup` tag and their route from Samsara's
 * record; /admin/vehicles sets a kind by hand (a service truck) that a later tag never changes, and
 * refuses a viewer or a driver (the page and the JSON route answer 403). Real app, real database,
 * real job clock (pnpm pilot or E2E_BASE_URL); nothing mocked.
 *
 * Runs under the sim stack (it skips unless CONNECTOR_SAMSARA=sim), once, in the `wall` project.
 * Terminal's hauler: ./pickups-terminal.spec.ts; replay mode: ./pickups-replay.spec.ts.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { getConfig } from '../src/config';
import { type MachineView, machineViewSchema } from '../src/domain/fleet';
import { buildSimFarm } from '../src/sim/index';
import { simTelematicsMachines } from '../src/sim/types';
import { SAMSARA_SIM_VEHICLE_TAGS_PATH } from '../src/sim/vendors/samsara/vehicles-routes-control';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { ICON_MAPPING, iconFor } from '../src/ui/map/fleet/style';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

const cfg = getConfig();
const farm = buildSimFarm(cfg.SIM_SEED);
const onFeed = simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' });
const PU1 = onFeed.find((m) => m.unitNo === 'PU1');
const PU2 = onFeed.find((m) => m.unitNo === 'PU2');
const PICKUPS = [PU1?.id, PU2?.id] as string[];
/** The carmaker grid (30 s) plus the 5 s demo cadence of fleet.trucks, with room to spare. */
const MAX_FIX_AGE_MS = 50_000;

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db?.end();
});

async function skipUnlessSim(page: Page, project: string) {
  test.skip(project !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  const { modes } = fleetPanelDataSchema.parse(await res.json());
  test.skip(modes.samsara !== 'sim', 'the sim stack (CONNECTOR_SAMSARA=sim)');
}

async function fleetApi(page: Page): Promise<MachineView[]> {
  const res = await page.request.get('/api/fleet');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { machines: unknown[] };
  return body.machines.map((m) => machineViewSchema.parse(m));
}

/** Run fleet.vehicles now (as the clock does), so the spec doesn't wait for its 59 s tick. */
async function runVehiclesJob(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/jobs/fleet.vehicles', {
    headers: { authorization: `Bearer ${cfg.JOBS_SECRET}` },
  });
  expect(res.status()).toBe(202);
}

/**
 * Poll `read` until it equals `want`, asking for a fleet.vehicles run each time (a run the clock
 * already holds answers 202 "busy" and does nothing, so one request alone may not be enough).
 */
async function untilVehicles<T>(
  request: APIRequestContext,
  read: () => Promise<T>,
  want: T,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await runVehiclesJob(request);
        return read();
      },
      { timeout: 60_000, intervals: [2_000], message },
    )
    .toEqual(want);
}

async function retag(vehicleId: string, tags: string[] | null): Promise<void> {
  const res = await fetch(`${cfg.VENDOR_SIM_URL}${SAMSARA_SIM_VEHICLE_TAGS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vehicleId, tags }),
  });
  expect(res.status, 'samsara vehicles knob').toBe(200);
}

async function kinds(): Promise<Record<string, [string, string, string | null]>> {
  const r = await db.query(
    `select unit_no, kind, kind_set_by, telematics_via from farm.machines
      where id = any($1::uuid[]) order by unit_no`,
    [PICKUPS],
  );
  return Object.fromEntries(
    r.rows.map((x) => [x.unit_no, [x.kind, x.kind_set_by, x.telematics_via]]),
  );
}

test('PU1 and PU2 on the board as pickups: their own icon, fresh on the 30 s grid, no hours or odometer', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(150_000);
  expect(iconFor('pickup')).toBe('pickup');
  expect(ICON_MAPPING.pickup).toBeDefined();
  await page.goto('/board');
  await waitForMap(page);
  const frames = () =>
    page.evaluate(
      (want) => (window.__map?.fleet() ?? []).filter((m) => want.includes(m.id)),
      PICKUPS,
    );
  await expect
    .poll(
      async () =>
        (await frames())
          .filter((m) => m.kind === 'pickup' && !m.stale && m.positionSource === 'eld')
          .map((m) => m.unitNo)
          .sort(),
      { timeout: 90_000, intervals: [2_000], message: 'PU1 and PU2 drawn as fresh pickups' },
    )
    .toEqual(['PU1', 'PU2']);
  // Drawn by the fleet icon layer (the pickup silhouette), and the atlas loaded without errors.
  const drawn = await page.evaluate(() => {
    const layer = window.__map?.deckLayers().find((l) => l.id === 'fleet-icons');
    return (layer?.data ?? []).map((d) => (d as { unitNo: string; kind: string }).kind);
  });
  expect(drawn.filter((k) => k === 'pickup')).toHaveLength(2);
  expect(await page.evaluate(() => window.__map?.errors() ?? [])).toEqual([]);

  // Still fresh a while later: their carmaker route reports every 30 s, the demo threshold is 60 s.
  await page.waitForTimeout(35_000);
  for (const m of (await fleetApi(page)).filter((x) => PICKUPS.includes(x.id))) {
    expect(m.stale, m.unitNo).toBe(false);
    expect(m.kind, m.unitNo).toBe('pickup');
    expect(Date.parse(m.ts) % 30_000, `${m.unitNo} on the 30 s grid`).toBe(0);
    expect(Date.now() - Date.parse(m.ts), `${m.unitNo} fix age (ms)`).toBeLessThan(MAX_FIX_AGE_MS);
  }
  const rows = await db.query(
    `select m.unit_no, m.engine_hours, m.odometer_mi, s.position_vendor, s.fuel_pct
       from farm.machines m join farm.machine_state s on s.machine_id = m.id
      where m.id = any($1::uuid[]) order by m.unit_no`,
    [PICKUPS],
  );
  expect(
    rows.rows.map((r) => [r.unit_no, r.engine_hours, r.odometer_mi, r.position_vendor]),
  ).toEqual([
    ['PU1', null, null, 'samsara'],
    ['PU2', null, null, 'samsara'],
  ]);
  // Fuel is the one stat their routes report.
  for (const r of rows.rows) expect(r.fuel_pct, `${r.unit_no} fuel`).not.toBeNull();
});

test("fleet.vehicles: the Pickup tag sets the kind; Samsara's record gives the carmaker route", async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(90_000);
  // As a database seeded before the routes were known.
  await db.query(
    `update farm.machines set kind_set_by = 'default', telematics_via = null where id = any($1::uuid[])`,
    [PICKUPS],
  );
  await retag(PU1?.telematics?.id as string, ['Pickup', 'Shop']); // a changed record: re-read
  await retag(PU2?.telematics?.id as string, ['Pickup', 'Shop']);
  try {
    await untilVehicles(
      page.request,
      kinds,
      { PU1: ['pickup', 'vendor', 'ford_pro'], PU2: ['pickup', 'vendor', 'stellantis'] },
      'fleet.vehicles set the kinds and routes',
    );
  } finally {
    await retag(PU1?.telematics?.id as string, null);
    await retag(PU2?.telematics?.id as string, null);
  }
});

test('/admin/vehicles: a manager sets a service truck that later tags never change; tags decide again after', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(120_000);
  await signInAs(page.context(), 'manager');
  const pu2 = PU2?.telematics?.id as string;
  try {
    await page.goto('/admin/vehicles');
    const row = page.locator(`[data-testid="vehicle-row"][data-unit="PU2"]`);
    await expect(row.getByTestId('vehicle-route')).toContainText('Stellantis Mobilisights');
    await expect(row.getByTestId('vehicle-not-reported')).toContainText('engine hours');
    await expect(row.getByTestId('vehicle-not-reported')).toContainText('not reported');
    await row.getByTestId('vehicle-kind-select').selectOption('service_truck');
    await row.getByTestId('vehicle-kind-save').click();
    await expect(page.getByTestId('admin-notice')).toContainText(
      'PU2 is now a service truck (set by hand)',
      { timeout: 20_000 },
    );
    expect((await kinds()).PU2).toEqual(['service_truck', 'admin', 'stellantis']);
    await expect(row.getByTestId('vehicle-kind-badge')).toHaveAttribute('data-set-by', 'admin');

    // Samsara says Semi now: the hand-set kind stays.
    await retag(pu2, ['Semi']);
    const semiLanded = async () =>
      (
        await db.query(
          `select count(*)::int as n from ingest.raw_events
            where source = 'samsara' and stream = 'vehicles' and status = 'processed'
              and external_id like $1 and payload::text like '%"Semi"%'`,
          [`${pu2}:%`],
        )
      ).rows[0].n > 0;
    await untilVehicles(page.request, semiLanded, true, 'the Semi tag landed');
    expect((await kinds()).PU2).toEqual(['service_truck', 'admin', 'stellantis']);

    // Let the tags decide: the next tag Samsara sends (Pickup) sets the kind again.
    await row.getByTestId('vehicle-kind-release').click();
    await expect(page.getByTestId('admin-notice')).toContainText(
      "follows the vendor's tags again",
      {
        timeout: 20_000,
      },
    );
    await retag(pu2, ['Pickup', 'Shop']);
    await untilVehicles(
      page.request,
      async () => (await kinds()).PU2,
      ['pickup', 'vendor', 'stellantis'],
      'the vendor tag decides again',
    );
  } finally {
    await retag(pu2, null);
    await db.query(
      `update farm.machines set kind = 'pickup', kind_set_by = 'vendor', telematics_via = 'stellantis'
        where id = $1`,
      [PU2?.id],
    );
  }
});

test('/admin/vehicles refuses a viewer and a driver: the page, and 403 from the server', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  for (const role of ['viewer', 'driver'] as const) {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await signInAs(ctx, role);
    const p = await ctx.newPage();
    await p.goto('/admin/vehicles');
    await expect(p.getByTestId('vehicles-no-access')).toHaveAttribute('data-status', '403');
    await expect(p.getByTestId('vehicles-table')).toHaveCount(0);
    const res = await p.request.post('/admin/vehicles/kind', {
      data: { machineId: PU1?.id, kind: 'service_truck' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status(), role).toBe(403);
    await ctx.close();
  }
  expect((await kinds()).PU1?.[0]).toBe('pickup');
});
