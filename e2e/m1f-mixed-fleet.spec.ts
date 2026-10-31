/**
 * Slices 1f and 1f.2 done-when in sim (docs/contracts-1f.md §11.5, §B.8.4), against the real app,
 * the real database and the vendor stand-ins, nothing mocked:
 *  - the mixed fleet on the board: every vendor's machines (Deere, the Samsara semis, pickups and
 *    RoGator, CNH, Kubota through AEMP, the hired haulers on Motive, Geotab and Terminal), each
 *    row with its vendor + mode badge from the registry and its kind badge;
 *  - the pickups' carmaker route reads "not reported" (never 0); a route with no fault system
 *    reads "faults not reported";
 *  - a critical code raised from /admin/connectors (the Samsara stand-in's knob) shows its badge,
 *    and offers a driver "Critical fault: mark down?" with the reason filled in; "Clear" clears it;
 *  - Deere flags as pins and this season's operations, synced from the Deere stand-in;
 *  - /admin/connectors lists every connection with its mode and capability matrix, the AEMP
 *    provider rows and Terminal's provider rows.
 *
 * Sim only (each test skips unless the connectors it reads run in sim). The fault test uses
 * semi S4, which no other spec gives codes (e2e/fleet-faults.spec.ts uses S3 and PU1).
 */
import { type BrowserContext, devices, expect, type Page, test } from '@playwright/test';
import { getConfig } from '../src/config';
import { vendorLabel } from '../src/connectors/vendors';
import { SAMSARA_SIM_FAULTS_CONTROL_PATH } from '../src/sim/vendors/samsara/control-types';
import { type FleetPanelData, fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { e2ePool, signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** Every vendor's machine and the position vendor it reports under (src/sim/farm/fleet.ts). */
const FLEET: Record<string, string> = {
  C1: 'deere',
  S1: 'samsara',
  PU1: 'samsara',
  PU2: 'samsara',
  SP2: 'samsara',
  C3: 'cnh',
  T1: 'cnh',
  L1: 'aemp_kubota',
  H1: 'motive',
  H2: 'geotab',
  H3: 'terminal_omnitracs_xrs',
};
/** fleet.aemp and fleet.cnh run every 30 s in the demo cadence; give them a few runs. */
const FLEET_WAIT_MS = 120_000;
const RUN_MS = 45_000;

async function panel(page: Page): Promise<FleetPanelData> {
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  return fleetPanelDataSchema.parse(await res.json());
}

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${id}"]`);

async function unitId(page: Page, unit: string): Promise<string> {
  const m = (await panel(page)).machines.find((x) => x.unitNo === unit);
  if (!m) throw new Error(`${unit} is not on the fleet panel (run pnpm db:seed demo)`);
  return m.id;
}

async function samsaraKnob(vehicle: string, codes: unknown[] | null): Promise<void> {
  const res = await fetch(`${getConfig().VENDOR_SIM_URL}${SAMSARA_SIM_FAULTS_CONTROL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vehicle, codes }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'own contexts: run once');
  await signInAs(page.context(), 'viewer');
  const { modes } = await panel(page);
  const notSim = Object.entries(modes).filter(([, m]) => m !== 'sim');
  test.skip(
    notSim.length > 0,
    `needs every connector in sim (${notSim.map(([c, m]) => `${c}=${m}`).join(', ')})`,
  );
});

test("the mixed fleet on the board: every vendor's machines with their vendor + mode badges", async ({
  page,
}) => {
  test.setTimeout(FLEET_WAIT_MS + 60_000);
  await page.goto('/board');
  await waitForMap(page, 90_000);
  await expect
    .poll(
      async () => {
        const by = new Map((await panel(page)).machines.map((m) => [m.unitNo, m]));
        return Object.keys(FLEET).filter((u) => by.get(u)?.position?.vendor !== FLEET[u]);
      },
      { timeout: FLEET_WAIT_MS, intervals: [3_000], message: 'units still without their vendor' },
    )
    .toEqual([]);
  const machines = (await panel(page)).machines;
  const drawn = await page.evaluate(() => (window.__map?.fleet() ?? []).map((f) => f.id));
  for (const [unit, vendor] of Object.entries(FLEET)) {
    const m = machines.find((x) => x.unitNo === unit);
    if (!m) throw new Error(unit);
    expect(drawn, `${unit} on the map`).toContain(m.id);
    await expect(row(page, m.id).getByTestId('fleet-vendor-badge'), unit).toHaveText(
      `${vendorLabel(vendor)} · sim`,
      { timeout: 15_000 },
    );
    await expect(row(page, m.id).getByTestId('vehicle-kind-badge')).toHaveAttribute(
      'data-kind',
      m.kind,
    );
  }
  // L1 (AEMP) is a last-known snapshot: no trail, never stale for 3 h.
  expect(machines.find((m) => m.unitNo === 'L1')?.position?.positionKind).toBe('last_known');
  await expect(
    row(page, machines.find((m) => m.unitNo === 'PU1')?.id as string).getByTestId(
      'vehicle-kind-badge',
    ),
  ).toContainText('Pickup');
});

test('the pickups read "not reported"; a route with no fault system reads "faults not reported"', async ({
  page,
}) => {
  test.setTimeout(FLEET_WAIT_MS);
  await page.goto('/board');
  await waitForMap(page, 90_000);
  for (const unit of ['PU1', 'PU2']) {
    const stats = row(page, await unitId(page, unit)).getByTestId('fleet-stats');
    await expect(stats).toContainText('hours not reported · odometer not reported', {
      timeout: RUN_MS,
    });
    await expect(stats).not.toContainText(/\b0 h\b/);
  }
  await expect
    .poll(async () => (await panel(page)).machines.filter((m) => m.faultsNotReported).length, {
      timeout: FLEET_WAIT_MS,
    })
    .toBeGreaterThan(0);
  for (const m of (await panel(page)).machines) {
    if (!m.faultsNotReported || m.faults?.length) continue;
    await expect(row(page, m.id).getByTestId('fleet-faults-not-reported'), m.unitNo).toHaveText(
      'faults not reported',
    );
  }
});

test('a critical code raised on /admin/connectors: the badge, "mark down?" for a driver, Clear', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const open = async (ctx: BrowserContext, path: string) => {
    const p = await ctx.newPage();
    await p.goto(path);
    return p;
  };
  const managerCtx = await browser.newContext();
  const driverCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await signInAs(managerCtx, 'manager');
  await signInAs(driverCtx, 'driver');
  try {
    await page.goto('/board');
    await waitForMap(page, 90_000);
    const s4 = await unitId(page, 'S4');
    const wallRow = row(page, s4);
    await expect(wallRow).toBeVisible({ timeout: 15_000 });

    const admin = await open(managerCtx, '/admin/connectors');
    const card = admin.getByTestId('sim-truck-faults');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByTestId('sim-truck-S4-raise').click();
    await expect(admin.getByTestId('admin-notice')).toContainText('S4: critical engine code', {
      timeout: 15_000,
    });

    const badge = wallRow.getByTestId('fleet-fault-badge');
    await expect(badge).toHaveText('Critical: J1939 SPN 110 FMI 0', { timeout: RUN_MS });
    await expect(badge).toHaveAttribute('data-severity', 'critical');
    // The wall is a viewer: the badge only, never the prompt.
    await expect(wallRow.getByTestId('fleet-critical-prompt')).toHaveCount(0);

    const phone = await open(driverCtx, '/m');
    await phone.getByTestId('fleet-panel-toggle').tap();
    const phoneRow = row(phone, s4);
    await phoneRow.getByTestId('fleet-critical-prompt').tap({ timeout: 15_000 });
    const sheet = phone.getByTestId('fleet-status-sheet');
    await expect(sheet.getByTestId('fleet-reason-text')).toHaveValue(
      /^Critical fault J1939 SPN 110 FMI 0/,
    );
    // Never marked down by the code itself: the driver decides (here: not now).
    await sheet.getByRole('button', { name: 'Cancel' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(wallRow).not.toHaveAttribute('data-group', 'down');

    await admin.reload();
    await admin.getByTestId('sim-truck-faults').getByTestId('sim-truck-S4-clear').click();
    await expect(badge).toHaveCount(0, { timeout: RUN_MS });
    await expect(wallRow).toHaveAttribute('data-fault', 'none');
  } finally {
    await samsaraKnob('S4', null).catch(() => {});
    await managerCtx.close();
    await driverCtx.close();
  }
});

test("Deere flags as pins and this season's operations, synced from the Deere stand-in", async ({
  page,
}) => {
  test.setTimeout(FLEET_WAIT_MS);
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/pins');
        expect(res.status()).toBe(200);
        const { pins } = (await res.json()) as { pins: { source: string; readOnly: boolean }[] };
        return pins.filter((p) => p.source === 'deere_flag' && p.readOnly).length;
      },
      { timeout: FLEET_WAIT_MS, message: 'deere.fields landed the stand-in flags' },
    )
    .toBeGreaterThan(0);
  let field: { id: string } | undefined;
  await expect
    .poll(
      async () => {
        field = (
          await e2ePool().query<{ id: string }>(
            `select field_id::text as id from farm.operations
              where source = 'deere' and field_id is not null
                and crop_year = extract(year from now() at time zone 'America/Detroit')::int
              limit 1`,
          )
        ).rows[0];
        return field !== undefined;
      },
      { timeout: FLEET_WAIT_MS, message: "deere.ops landed this season's operations" },
    )
    .toBe(true);
  const res = await page.request.get(`/api/fields/${field?.id}/operations`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { cropYear: number; operations: { kind: string }[] };
  expect(body.operations.length).toBeGreaterThan(0);
});

test("/admin/connectors: every connection's mode and capabilities, the AEMP and Terminal providers", async ({
  page,
}) => {
  test.setTimeout(FLEET_WAIT_MS);
  await signInAs(page.context(), 'manager');
  await page.goto('/admin/connectors');
  const matrix = page.getByTestId('capability-matrix');
  for (const c of ['deere', 'samsara', 'motive', 'geotab', 'aemp', 'cnh', 'terminal']) {
    await expect(matrix.getByTestId(`connection-${c}`)).toBeVisible();
    await expect(page.getByTestId(`connector-mode-${c}`)).toContainText('sim');
  }
  // Every connection's client is built (no "client not built yet").
  await expect(page.getByTestId('connections-card')).not.toContainText('client not built yet');
  await expect(matrix.getByTestId('provider-aemp_kubota')).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId('terminal-provider-omnitracs-xrs').count();
      },
      { timeout: FLEET_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .toBeGreaterThan(0);
  await expect(page.getByTestId('sim-truck-faults')).toBeVisible();
});
