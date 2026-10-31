/**
 * Slice 1f, fleet-faults (docs/contracts-1f.md §11.3), in sim mode against the real app, the
 * real database and the Samsara stand-in, nothing mocked:
 *  - a red-stop-lamp code on semi S3 (set with the stand-in's fault-code knob, the breakdown
 *    scenario's code without switching the shared scenario) shows a critical badge on the fleet
 *    panel within a fleet.trucks run; a viewer (the wall) sees the badge only; a driver's phone
 *    offers "Critical fault: mark down?", which opens the status sheet with the reason filled in
 *    (marked down, then back up); clearing the code with the knob clears the badge;
 *  - every row carries its vendor + mode badge and its stats line: hours and odometer for the
 *    Samsara semis, "not reported" for the Ford pickup's (Ford Pro through Samsara);
 *  - the phone's machine card shows the tapped machine's code (the fault tag).
 *
 * The knob changes the one shared stand-in, so every test runs in the `wall` project only, with
 * its own contexts, and hands the vehicles back to the scenario afterwards. Sim only: under
 * CONNECTOR_SAMSARA=replay the tests skip (e2e/fleet-panel-replay.spec.ts checks the replayed
 * fault codes there).
 */
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { getConfig } from '../src/config';
import {
  SAMSARA_SIM_FAULTS_CONTROL_PATH,
  type SamsaraSimFault,
  SIM_RED_STOP_FAULT,
} from '../src/sim/vendors/samsara/control-types';
import { type FleetPanelData, fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** fleet.trucks runs every 5 s in the demo cadence (30 s live) and lands a change in one run. */
const RUN_MS = 45_000;

/** Give a Samsara vehicle codes from now on ([] = none; null = back to the scenario). */
async function simFaults(vehicle: string, codes: SamsaraSimFault[] | null): Promise<void> {
  const res = await fetch(`${getConfig().VENDOR_SIM_URL}${SAMSARA_SIM_FAULTS_CONTROL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vehicle, codes }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function wallContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  await signInAs(ctx, 'viewer');
  return ctx;
}

async function phoneContext(browser: Browser, role: 'viewer' | 'driver'): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await signInAs(ctx, role);
  return ctx;
}

async function machines(page: Page): Promise<FleetPanelData> {
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  return fleetPanelDataSchema.parse(await res.json());
}

async function machineId(page: Page, unitNo: string): Promise<string> {
  const m = (await machines(page)).machines.find((x) => x.unitNo === unitNo);
  if (!m) throw new Error(`${unitNo} is not on the fleet panel (is the demo farm seeded?)`);
  return m.id;
}

const panelRow = (page: Page, id: string) =>
  page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${id}"]`);

/** These tests drive the Samsara stand-in: skip unless the app runs Samsara in sim mode. */
test.beforeEach(async ({ browser }, info) => {
  if (info.project.name !== 'wall') return;
  const ctx = await browser.newContext();
  try {
    await signInAs(ctx, 'viewer');
    const page = await ctx.newPage();
    const { modes } = await machines(page);
    test.skip(modes.samsara !== 'sim', 'needs CONNECTOR_SAMSARA=sim (the stand-in fault knob)');
  } finally {
    await ctx.close();
  }
});

test('a critical code: the badge everywhere, "mark down?" for a driver, cleared by the knob', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'own wall and phone contexts: run once');
  test.setTimeout(150_000);
  const wallCtx = await wallContext(browser);
  const phoneCtx = await phoneContext(browser, 'driver');
  const wall = await wallCtx.newPage();
  const phone = await phoneCtx.newPage();
  let s3: string | null = null;
  try {
    await wall.goto('/board');
    await waitForMap(wall);
    s3 = await machineId(wall, 'S3');
    const wallRow = panelRow(wall, s3);
    await expect(wallRow).toBeVisible({ timeout: 15_000 });

    await simFaults('S3', [SIM_RED_STOP_FAULT]);
    // The wall (a viewer): the badge, worst code first, and no prompt.
    const badge = wallRow.getByTestId('fleet-fault-badge');
    await expect(badge).toHaveText('Critical: J1939 SPN 110 FMI 0', { timeout: RUN_MS });
    await expect(badge).toHaveAttribute('data-severity', 'critical');
    await expect(badge).toHaveAttribute('title', /Engine Coolant Temperature/);
    await expect(wallRow).toHaveAttribute('data-fault', 'critical');
    await expect(wall.getByTestId('fleet-critical-prompt')).toHaveCount(0);
    const listed = (await machines(wall)).machines.find((m) => m.id === s3);
    expect(listed?.faults).toMatchObject([
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical', system: 'j1939', spn: 110, fmi: 0 },
    ]);

    // A driver's phone: "Critical fault: mark down?" opens the sheet with the reason filled in.
    await phone.goto('/m');
    await phone.getByTestId('fleet-panel-toggle').tap();
    const phoneRow = panelRow(phone, s3);
    await expect(phoneRow.getByTestId('fleet-fault-badge')).toBeVisible({ timeout: 15_000 });
    await phoneRow.getByTestId('fleet-critical-prompt').tap();
    const sheet = phone.getByTestId('fleet-status-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('fleet-reason-text')).toHaveValue(
      /^Critical fault J1939 SPN 110 FMI 0: Engine Coolant Temperature/,
    );
    await expect(sheet.getByTestId('fleet-status-submit')).toBeEnabled();
    await sheet.getByTestId('fleet-status-submit').tap();
    // Marked down by a person, never by the code: the wall shows it; the prompt is gone.
    await expect(wallRow).toHaveAttribute('data-group', 'down', { timeout: 5_000 });
    await expect(wallRow).toContainText('Down: Critical fault J1939 SPN 110 FMI 0');
    await expect(phoneRow.getByTestId('fleet-critical-prompt')).toHaveCount(0);
    // Back up (the other specs expect every machine active).
    await phoneRow.getByTestId('fleet-mark-up').tap();
    await phone.getByTestId('fleet-status-sheet').getByTestId('fleet-status-submit').tap();
    await expect(wallRow).not.toHaveAttribute('data-group', 'down', { timeout: 5_000 });
    await expect(phoneRow.getByTestId('fleet-critical-prompt')).toBeVisible();

    // Cleared with the knob: the badge goes on the wall and the phone, and stays gone.
    await simFaults('S3', []);
    await expect(wallRow.getByTestId('fleet-fault-badge')).toHaveCount(0, { timeout: RUN_MS });
    await expect(wallRow).toHaveAttribute('data-fault', 'none');
    await expect(phoneRow.getByTestId('fleet-fault-badge')).toHaveCount(0, { timeout: 15_000 });
    await wall.waitForTimeout(6_000); // another run: nothing brings it back
    await expect(wallRow.getByTestId('fleet-fault-badge')).toHaveCount(0);
  } finally {
    await simFaults('S3', null).catch(() => {});
    if (s3) {
      await phone.request
        .post(`/api/machines/${s3}/status`, { data: { status: 'active' } })
        .catch(() => {});
    }
    await wallCtx.close();
    await phoneCtx.close();
  }
});

test('every row: its vendor + mode badge and stats ("not reported" for the Ford pickup)', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  const ctx = await wallContext(browser);
  try {
    const wall = await ctx.newPage();
    await wall.goto('/board');
    await waitForMap(wall);
    const s1 = panelRow(wall, await machineId(wall, 'S1'));
    await expect(s1.getByTestId('fleet-vendor-badge')).toHaveText('Samsara · sim', {
      timeout: 30_000,
    });
    await expect(s1.getByTestId('fleet-stats')).toHaveText(/^[\d,]+ h · [\d,]+ mi · fuel \d+ %/, {
      timeout: RUN_MS,
    });
    const pu1 = panelRow(wall, await machineId(wall, 'PU1'));
    await expect(pu1.getByTestId('fleet-vendor-badge')).toHaveText('Samsara · sim', {
      timeout: RUN_MS,
    });
    await expect(pu1.getByTestId('fleet-stats')).toContainText(
      'hours not reported · odometer not reported',
    );
    await expect(pu1.getByTestId('fleet-stats')).not.toContainText('0 h');
    // A Deere combine's badge names Deere with its own mode.
    const c1 = panelRow(wall, await machineId(wall, 'C1'));
    await expect(c1.getByTestId('fleet-vendor-badge')).toHaveText(/^John Deere · (sim|replay)$/, {
      timeout: RUN_MS,
    });
  } finally {
    await ctx.close();
  }
});

test("the phone's machine card shows the tapped machine's code", async ({ browser }, info) => {
  test.skip(info.project.name !== 'wall', 'own phone context: run once');
  test.setTimeout(120_000);
  const ctx = await phoneContext(browser, 'viewer');
  try {
    const phone = await ctx.newPage();
    await phone.goto('/m');
    await waitForMap(phone);
    // PU1 is parked at the shop in every scenario: a still target. Ford Pro reports OBD-II.
    await simFaults('PU1', [
      { system: 'obd2', dtc: 'P0087', description: 'Fuel Rail/System Pressure - Too Low' },
    ]);
    const pu1 = await machineId(phone, 'PU1');
    await expect
      .poll(
        async () =>
          (await machines(phone)).machines.find((m) => m.id === pu1)?.faults?.[0]?.code ?? null,
        { timeout: RUN_MS, message: 'PU1 reports P0087' },
      )
      .toBe('P0087');
    const where = await phone.evaluate(
      (id) => window.__map?.fleet().find((f) => f.id === id) ?? null,
      pu1,
    );
    if (!where) throw new Error('PU1 is not on the map');
    await phone.evaluate(([lng, lat]) => window.__map?.jumpTo({ center: [lng, lat], zoom: 19 }), [
      where.lng,
      where.lat,
    ] as const);
    await phone.evaluate(() => window.__map?.idle(5_000));
    const p = await phone.evaluate(([lng, lat]) => window.__map?.project(lng, lat), [
      where.lng,
      where.lat,
    ] as const);
    if (!p) throw new Error('no projection');
    await phone.touchscreen.tap(p.x, p.y);
    const card = phone.getByTestId('machine-details');
    await expect(card).toContainText('PU1');
    await expect(card.getByTestId('machine-fault-tag')).toHaveText('Warning: P0087', {
      timeout: 15_000,
    });
    await expect(card.getByTestId('machine-fault-tag')).toHaveAttribute('data-severity', 'warning');
  } finally {
    await simFaults('PU1', null).catch(() => {});
    await ctx.close();
  }
});
