/**
 * Fleet panel (plan 1a): machines grouped moving / idle / down / stale with a position-source
 * badge and last-seen age; tapping one centres the map; a driver marks a combine down on a
 * PHONE and the WALL shows it within 2 s (panel row in "Down" and the map marker's down
 * style), then marks it back up. Real app, real database, real realtime (pnpm pilot or
 * E2E_BASE_URL): nothing mocked.
 *
 * Runs once, in the `wall` project, with its own wall and phone contexts (two projects marking
 * the same machine at once would race).
 */
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { type FleetPanelData, fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** Plan 1a done-when: "Marking a combine down on your phone updates the wall within 2 s". */
const WALL_UPDATE_MS = 2_000;

async function wallContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  await signInAs(ctx, 'viewer');
  return ctx;
}

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await signInAs(ctx, 'driver');
  return ctx;
}

async function machines(page: Page): Promise<FleetPanelData> {
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  return fleetPanelDataSchema.parse(await res.json());
}

/** A machine that is on the map right now (a combine if one is), not down. */
async function machineOnMap(page: Page): Promise<FleetPanelData['machines'][number]> {
  let pick: FleetPanelData['machines'][number] | undefined;
  await expect
    .poll(
      async () => {
        const list = (await machines(page)).machines.filter(
          (m) => m.position !== null && m.status === 'active',
        );
        pick = list.find((m) => m.kind === 'combine') ?? list[0];
        return pick?.id ?? null;
      },
      { timeout: 45_000, message: 'a machine with a position (is the clock running?)' },
    )
    .not.toBeNull();
  return pick as FleetPanelData['machines'][number];
}

const panelRow = (page: Page, id: string) =>
  page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${id}"]`);

async function markerStatus(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (mid) => window.__map?.fleet().find((m) => m.id === mid)?.status ?? null,
    id,
  );
}

test('the wall panel groups machines with a source badge and age; a tap centres the map', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'own wall context: run once');
  const ctx = await wallContext(browser);
  try {
    const wall = await ctx.newPage();
    await wall.goto('/board');
    await waitForMap(wall);
    const panel = wall.getByTestId('fleet-panel');
    await expect(panel).toBeVisible();
    const target = await machineOnMap(wall);
    const row = panelRow(wall, target.id);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute('data-group', /^(moving|idle|stale)$/);
    await expect(row.getByTestId('fleet-source-badge')).toHaveText(/^(ELD|Deere|Cab|Manual)$/);
    await expect(row.getByTestId('fleet-age')).toHaveText(/^Seen /);
    // Every group heading the panel shows is one of the four.
    for (const g of await panel.locator('section[data-group]').all()) {
      expect(['moving', 'idle', 'down', 'stale']).toContain(await g.getAttribute('data-group'));
    }
    // A viewer gets no Down buttons, and the server refuses one anyway.
    await expect(wall.getByTestId('fleet-mark-down')).toHaveCount(0);
    const refused = await wall.request.post(`/api/machines/${target.id}/status`, {
      data: { status: 'down', reason: 'not allowed' },
    });
    expect(refused.status()).toBe(403);

    // Tap the row: the map flies to the machine.
    await wall.evaluate(() => window.__map?.jumpTo({ center: [-84.3, 42.1], zoom: 10 }));
    await row.locator('button').first().tap();
    await expect
      .poll(
        async () => {
          const c = await wall.evaluate(() => window.__map?.center());
          const m = (await machines(wall)).machines.find((x) => x.id === target.id);
          if (!c || !m?.position) return Number.POSITIVE_INFINITY;
          return Math.hypot(c.lng - m.position.lng, c.lat - m.position.lat);
        },
        { timeout: 10_000, message: 'map centred on the machine' },
      )
      .toBeLessThan(0.02);
  } finally {
    await ctx.close();
  }
});

test('a phone marks a machine down with a reason: the wall shows it within 2 s, then back up', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'own wall and phone contexts: run once');
  const wallCtx = await wallContext(browser);
  const phoneCtx = await phoneContext(browser);
  const wall = await wallCtx.newPage();
  const phone = await phoneCtx.newPage();
  let targetId: string | null = null;
  try {
    await wall.goto('/board');
    await waitForMap(wall);
    const target = await machineOnMap(wall);
    targetId = target.id;
    const wallRow = panelRow(wall, target.id);
    await expect(wallRow).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => markerStatus(wall, target.id), { timeout: 30_000 }).toBe('active');

    await phone.goto('/m');
    await phone.getByTestId('fleet-panel-toggle').tap();
    const phoneRow = panelRow(phone, target.id);
    await expect(phoneRow).toBeVisible({ timeout: 15_000 });
    await phoneRow.getByTestId('fleet-mark-down').tap();
    const sheet = phone.getByTestId('fleet-status-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('fleet-status-submit')).toBeDisabled(); // a reason is required
    await sheet.getByTestId('fleet-reason-hydraulic-leak').tap();
    await sheet.getByTestId('fleet-reason-text').fill('header hose');

    const t0 = Date.now();
    await sheet.getByTestId('fleet-status-submit').tap();
    await expect(wallRow).toHaveAttribute('data-group', 'down', { timeout: WALL_UPDATE_MS });
    await expect
      .poll(() => markerStatus(wall, target.id), {
        timeout: Math.max(1, WALL_UPDATE_MS - (Date.now() - t0)),
        intervals: [50],
      })
      .toBe('down');
    expect(Date.now() - t0).toBeLessThanOrEqual(WALL_UPDATE_MS + 250);
    await expect(wallRow).toContainText('Down: Hydraulic leak: header hose');
    await expect(sheet).toBeHidden();
    await expect(phoneRow).toHaveAttribute('data-group', 'down');

    // Back up from the phone: the wall follows just as fast.
    await phoneRow.getByTestId('fleet-mark-up').tap();
    const t1 = Date.now();
    await phone.getByTestId('fleet-status-sheet').getByTestId('fleet-status-submit').tap();
    await expect(wallRow).not.toHaveAttribute('data-group', 'down', { timeout: WALL_UPDATE_MS });
    await expect
      .poll(() => markerStatus(wall, target.id), {
        timeout: Math.max(1, WALL_UPDATE_MS - (Date.now() - t1)),
        intervals: [50],
      })
      .toBe('active');
    targetId = null;
  } finally {
    if (targetId) {
      // Never leave a machine down for the other specs.
      await phone.request
        .post(`/api/machines/${targetId}/status`, { data: { status: 'active' } })
        .catch(() => {});
    }
    await wallCtx.close();
    await phoneCtx.close();
  }
});
