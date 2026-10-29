/**
 * Fleet on the map: markers come from a mocked GET /api/fleet snapshot, glide to new positions
 * on a mocked realtime `fleet`/`tick`, go stale on the browser clock, and a tap selects one.
 *
 * The snapshot endpoint is route-mocked; realtime is a test double installed before the app
 * loads (window.__farmTestRealtime, see e2e/support/map.ts), and /api/realtime is route-blocked
 * so nothing real interferes. The SSE wire format is covered by the runtime agent's
 * e2e/realtime*.spec.ts; e2e/fleet*.spec.ts (vendors) covers the real /api/fleet.
 */
import { expect, type Page, test } from '@playwright/test';
import { getConfig } from '../src/config';
import type { FleetTick, MachineView } from '../src/domain/fleet';
import { installFakeRealtime, mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

/** The running app's FLEET_STALE_SECONDS (same env files as this checkout). */
const STALE_S = getConfig().FLEET_STALE_SECONDS;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function machine(n: number, over: Partial<MachineView>): MachineView {
  return {
    id: id(n),
    unitNo: `U${n}`,
    kind: 'semi',
    lng: -83.9,
    lat: 41.88,
    heading: 90,
    speedMph: 40,
    activity: 'transport',
    fieldId: null,
    positionSource: 'eld',
    ts: new Date().toISOString(),
    status: 'active',
    stale: false,
    ...over,
  };
}

function snapshot(): FleetTick {
  const now = Date.now();
  return {
    ts: new Date(now).toISOString(),
    machines: [
      machine(1, { unitNo: 'C1', kind: 'combine', lng: -83.92, lat: 41.88, activity: 'working' }),
      machine(2, { unitNo: 'S1', kind: 'semi', lng: -83.88, lat: 41.875 }),
      // Last fix 10 minutes older than the stale threshold: stale on arrival.
      machine(3, {
        unitNo: 'S2',
        kind: 'semi',
        lng: -83.9,
        lat: 41.89,
        ts: new Date(now - (STALE_S + 600) * 1000).toISOString(),
      }),
    ],
  };
}

async function openBoard(page: Page, path: string, ticks: FleetTick | (() => FleetTick)) {
  let snapshots = 0;
  await page.route('**/api/fleet', async (route) => {
    snapshots++;
    await route.fulfill({ json: typeof ticks === 'function' ? ticks() : ticks });
  });
  await page.route('**/api/realtime**', (route) => route.abort('blockedbyclient'));
  await installFakeRealtime(page);
  await page.goto(path);
  await waitForMap(page);
  await page.evaluate(() =>
    window.__map?.jumpTo({ center: [-83.9, 41.882], zoom: 12.5, bearing: 0 }),
  );
  await mapIdle(page);
  return { snapshots: () => snapshots };
}

const fleet = (page: Page) => page.evaluate(() => window.__map?.fleet() ?? []);

test('markers appear from the snapshot, glide on a tick, and show staleness', async ({
  page,
}, testInfo) => {
  const tick = snapshot();
  const board = await openBoard(page, mapPathFor(testInfo), tick);

  await expect
    .poll(async () => (await fleet(page)).map((f) => f.unitNo))
    .toEqual(['C1', 'S1', 'S2']);
  expect(board.snapshots()).toBeGreaterThanOrEqual(1);
  const layers = await page.evaluate(() => window.__map?.deckLayers() ?? []);
  expect(layers.map((l) => [l.id, l.data.length])).toEqual([
    ['fleet-halo', 3],
    ['fleet-icons', 3],
    ['fleet-labels', 3],
  ]);
  const initial = await fleet(page);
  expect(initial.find((f) => f.unitNo === 'S2')?.stale).toBe(true);
  expect(initial.find((f) => f.unitNo === 'S1')?.stale).toBe(false);
  await expect(page.getByTestId('badge-stale')).toHaveText('1 stale');
  await expect(page.getByTestId('fleet-summary')).toHaveText('3 machines');

  // A realtime tick moves S1 east by 0.01° (~830 m) and refreshes S2.
  const s1Before = initial.find((f) => f.unitNo === 'S1');
  const moved = tick.machines.map((m) =>
    m.unitNo === 'S1'
      ? { ...m, lng: m.lng + 0.01, heading: 80, ts: new Date().toISOString() }
      : m.unitNo === 'S2'
        ? { ...m, ts: new Date().toISOString() }
        : m,
  );
  await page.evaluate(
    (machines) =>
      window.__fleetEmit?.('fleet', {
        event: 'tick',
        seq: 2,
        payload: { ts: new Date().toISOString(), machines },
      }),
    moved,
  );

  // Mid-glide: strictly between the old and the new position.
  await expect
    .poll(async () => (await fleet(page)).find((f) => f.unitNo === 'S1')?.lng ?? 0, {
      intervals: [100],
    })
    .toBeGreaterThan((s1Before?.lng ?? 0) + 0.0005);
  const mid = (await fleet(page)).find((f) => f.unitNo === 'S1');
  expect(mid?.lng).toBeLessThan((s1Before?.lng ?? 0) + 0.01);

  // Then it arrives, and the refreshed S2 is no longer stale.
  await expect
    .poll(async () => (await fleet(page)).find((f) => f.unitNo === 'S1')?.lng, { timeout: 15_000 })
    .toBeCloseTo((s1Before?.lng ?? 0) + 0.01, 6);
  await expect(page.getByTestId('badge-stale')).toHaveCount(0);
  expect((await fleet(page)).every((f) => !f.stale)).toBe(true);
});

test('a resync (reconnect, seq gap, invalidate) refetches the snapshot', async ({
  page,
}, testInfo) => {
  let current = snapshot();
  const board = await openBoard(page, mapPathFor(testInfo), () => current);
  await expect.poll(async () => (await fleet(page)).length).toBe(3);
  expect(await page.evaluate(() => window.__fleetResyncs)).toBe(1);
  const before = board.snapshots();
  // Server side, S2 was retired and C1 moved; the client learns it only from the snapshot.
  current = {
    ts: new Date().toISOString(),
    machines: current.machines
      .filter((m) => m.unitNo !== 'S2')
      .map((m) =>
        m.unitNo === 'C1' ? { ...m, lng: m.lng - 0.002, ts: new Date().toISOString() } : m,
      ),
  };
  await page.evaluate(() => window.__fleetResync?.());
  await expect.poll(() => board.snapshots()).toBe(before + 1);
  await expect.poll(async () => (await fleet(page)).map((f) => f.unitNo)).toEqual(['C1', 'S1']);
  await expect(page.getByTestId('fleet-summary')).toHaveText('2 machines');
});

test('a machine turns stale on the browser clock without any tick', async ({ page }, testInfo) => {
  test.skip(STALE_S < 20, 'needs FLEET_STALE_SECONDS >= 20');
  // Fresh for 12 more seconds (then older than FLEET_STALE_SECONDS); no tick will arrive.
  const now = Date.now();
  const tick: FleetTick = {
    ts: new Date(now).toISOString(),
    machines: [
      machine(7, { unitNo: 'S7', ts: new Date(now - (STALE_S - 12) * 1000).toISOString() }),
    ],
  };
  await openBoard(page, mapPathFor(testInfo), tick);
  await expect.poll(async () => (await fleet(page)).map((f) => f.stale)).toEqual([false]);
  await expect(page.getByTestId('badge-stale')).toHaveCount(0);
  // The 5 s staleness timer (contracts §7) flips it and shows the badge.
  await expect(page.getByTestId('badge-stale')).toHaveText('1 stale', { timeout: 30_000 });
  expect((await fleet(page))[0]?.stale).toBe(true);
  await expect(page.getByTestId('fleet-stale-count')).toHaveText('1 stale');
});

test('tapping a machine selects it', async ({ page }, testInfo) => {
  await openBoard(page, mapPathFor(testInfo), snapshot());
  await expect.poll(async () => (await fleet(page)).length).toBe(3);
  const c1 = (await fleet(page)).find((f) => f.unitNo === 'C1');
  if (!c1) throw new Error('C1 missing');
  const p = await page.evaluate(([lng, lat]) => window.__map?.project(lng, lat), [
    c1.lng,
    c1.lat,
  ] as const);
  if (!p) throw new Error('no projection');
  await page.touchscreen.tap(p.x, p.y);
  if (testInfo.project.name === 'phone') {
    await expect(page.getByTestId('machine-details')).toContainText('C1');
  } else {
    await expect(page.getByTestId('machine-card')).toContainText('C1');
    await expect(page.getByTestId('machine-card')).toContainText('Combine');
  }
});

test('without a fleet endpoint the board says so instead of failing', async ({
  page,
}, testInfo) => {
  await page.route('**/api/fleet', (route) => route.fulfill({ status: 503, body: 'down' }));
  await installFakeRealtime(page);
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  await expect(page.getByTestId('badge-fleet-unavailable')).toBeVisible();
  expect(await fleet(page)).toEqual([]);
});
