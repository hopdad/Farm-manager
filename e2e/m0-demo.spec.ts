/**
 * The M0 demo (docs/build-plan.md §6 M0 "Done when"), end to end against the real stack: the
 * vendor stand-in, the fleet jobs fired by the clock, realtime, /board, /m and /admin/connectors.
 * Nothing is mocked. Every browser context blocks every non-local host, so the whole run also
 * proves the "internet unplugged" item for the browser side.
 *
 *   2. offline basemap with labels, about 40 demo fields, 2 combines, 2 carts, 4 semis moving
 *   3. pause the simulation on /admin/connectors: they freeze (and stay fresh); resume: they move.
 *      "trucks API down": the trucks go stale with a badge; off: they catch up
 *   4. a phone context at /m (over the machine's LAN address when it has one) shows the same
 *      fixes within 2 s of the wall
 *   5. no request ever leaves for a non-local host
 *
 * It drives the shared simulation, so it runs once (wall project), serially, and puts things
 * back afterwards (simulation resumed, fault off, the speed it found). It restarts harvest-day
 * at 30x so the day's first hour (combines start at 07:11, carts and semis follow) passes in
 * about two minutes. Needs JOBS_DEMO_CADENCE=on (pnpm env:init writes it) for 5 s truck polls.
 */
import { networkInterfaces } from 'node:os';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { getConfig, getE2eSettings } from '../src/config';
import type { FleetFrame } from '../src/ui/map/fleet/model';
import { unlockAdmin } from './support/admin';
import { signInAs } from './support/auth';
import { blockExternalHosts, mapIdle, waitForMap } from './support/map';

test.describe.configure({ mode: 'serial' });

const cfg = getConfig();
/** FLEET_STALE_SECONDS of the app under test (same env files as this checkout). */
const STALE_S = cfg.FLEET_STALE_SECONDS;
const DEMO_SPEED = 30;
const BASE_URL = getE2eSettings().baseURL;
const isWall = () => test.info().project.name === 'wall';

const fleet = (page: Page): Promise<FleetFrame[]> =>
  page.evaluate(() => window.__map?.fleet() ?? []);

/** Metres between two WGS84 points (equirectangular; fine at field scale). */
function meters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const k = Math.PI / 180;
  const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6_371_000;
}

/**
 * A non-loopback IPv4 address of this machine, as a phone on the LAN would use it: one listed in
 * DEV_ORIGINS first (what bootstrap prints and `next dev` allows), else the first one found.
 */
function lanAddress(): string | null {
  const mine = Object.values(networkInterfaces())
    .flatMap((a) => a ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return mine.find((ip) => cfg.DEV_ORIGINS.includes(ip)) ?? mine[0] ?? null;
}

interface Opened {
  context: BrowserContext;
  page: Page;
  blocked: string[];
}

async function openMap(
  browser: Browser,
  url: string,
  options: Parameters<Browser['newContext']>[0],
): Promise<Opened> {
  const context = await browser.newContext(options);
  // A viewer session for the host this context opens (the phone uses the LAN address).
  await signInAs(context, 'viewer', new URL(url).origin);
  const page = await context.newPage();
  const blocked = await blockExternalHosts(page, url);
  await page.goto(url);
  await waitForMap(page);
  await mapIdle(page);
  return { context, page, blocked };
}

// ---- /admin/connectors -----------------------------------------------------------------------

async function admin(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/admin/connectors`);
  await expect(page.getByTestId('sim-card')).toBeVisible();
  await expect(page.getByTestId('sim-card')).not.toContainText('not reachable');
}

/** The stand-in's speed as the admin page shows it (null while paused). */
async function shownSpeed(page: Page): Promise<number | null> {
  const text = (await page.getByTestId('sim-card').textContent()) ?? '';
  const m = /Sim time.*?(\d+(?:\.\d+)?)x/.exec(text);
  return m ? Number(m[1]) : null;
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  await page
    .getByTestId('sim-card')
    .getByRole('button', { name: `${speed}x`, exact: true })
    .tap();
  await expect(
    page.getByTestId('sim-card').getByRole('button', { name: `${speed}x`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
}

async function setPaused(page: Page, paused: boolean): Promise<void> {
  const pause = page.getByTestId('sim-pause');
  const resume = page.getByTestId('sim-resume');
  if (paused && (await pause.count())) await pause.tap();
  if (!paused && (await resume.count())) await resume.tap();
  await expect(paused ? resume : pause).toBeVisible();
}

async function setTrucksDown(page: Page, on: boolean): Promise<void> {
  const toggle = page.getByTestId('fault-trucks-down');
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}

async function restartHarvestDay(page: Page): Promise<void> {
  await page.locator('#scenario-select').selectOption('harvest-day');
  await page.getByTestId('sim-card').getByRole('button', { name: 'Start scenario' }).tap();
  await expect(page.getByTestId('admin-notice')).toBeVisible();
}

// ---- the run ---------------------------------------------------------------------------------

let adminCtx: BrowserContext;
let adminPage: Page;
let foundSpeed: number | null = null;
let wall: Opened;
const opened: Opened[] = [];

test.beforeAll(async ({ browser }) => {
  if (!isWall()) return;
  adminCtx = await browser.newContext({ hasTouch: true });
  await unlockAdmin(adminCtx, BASE_URL);
  adminPage = await adminCtx.newPage();
  await blockExternalHosts(adminPage, BASE_URL);
  await admin(adminPage);
  await setTrucksDown(adminPage, false);
  await setPaused(adminPage, false);
  foundSpeed = await shownSpeed(adminPage);
  await restartHarvestDay(adminPage);
  await setSpeed(adminPage, DEMO_SPEED);
});

test.afterAll(async () => {
  for (const o of opened) await o.context.close();
  if (!adminPage) return;
  await admin(adminPage);
  await setTrucksDown(adminPage, false);
  await setPaused(adminPage, false);
  if (foundSpeed && [1, 5, 30, 60].includes(foundSpeed)) await setSpeed(adminPage, foundSpeed);
  await adminCtx.close();
});

test.beforeEach(() => {
  test.skip(!isWall(), 'drives the shared simulation: runs once');
});

test('the board: offline basemap with labels, ~40 demo fields, the fleet moving', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(360_000);
  wall = await openMap(browser, `${baseURL}/board`, {
    ...devices['Desktop Chrome'],
    viewport: { width: 1920, height: 1080 },
    hasTouch: true,
  });
  opened.push(wall);
  const { page } = wall;

  // The offline basemap is installed and draws labels from the local fonts.
  await expect(page.getByTestId('badge-basemap-missing')).toHaveCount(0);
  await expect(page.getByTestId('status-strip')).toBeVisible();

  // About 40 demo fields around Adrian, Blissfield, Deerfield, Petersburg and Dundee.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const f = window.__map?.queryRenderedFeatures({ layers: ['fields-fill'] }) ?? [];
          return new Set(f.map((x) => String(x.properties.id))).size;
        }),
      { timeout: 20_000, message: 'distinct fields drawn' },
    )
    .toBeGreaterThanOrEqual(38);
  await page.evaluate(() =>
    window.__map?.jumpTo({ center: [-84.0372, 41.8975], zoom: 11.5, bearing: 0 }),
  );
  await mapIdle(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['places_locality'] })
              .map((f) => String(f.properties.name ?? '')) ?? [],
        ),
      { timeout: 20_000, message: 'town labels drawn' },
    )
    .toContain('Adrian');

  // 2 combines, 2 grain carts and 4 semis, each seen moving.
  const first = new Map<string, FleetFrame>();
  const moved = new Set<string>();
  await expect
    .poll(
      async () => {
        for (const m of await fleet(page)) {
          const f = first.get(m.id);
          if (!f) first.set(m.id, m);
          else if (meters(f, m) > 5) moved.add(m.id);
        }
        const count = (kind: string) =>
          [...first.values()].filter((m) => m.kind === kind && moved.has(m.id)).length;
        return { combine: count('combine'), grain_cart: count('grain_cart'), semi: count('semi') };
      },
      // Carts: Deere records them only while working (a minute or two at a time), sampled
      // every 10 s of wall time, so at 30x most bursts are missed: give them a few minutes.
      { timeout: 300_000, intervals: [2_000], message: 'machines seen moving' },
    )
    .toEqual({ combine: 2, grain_cart: 2, semi: 4 });
  expect(wall.blocked, 'requests to non-local hosts').toEqual([]);
});

test('a phone at /m (over the LAN address) shows the same fixes within 2 s of the wall', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = new URL(baseURL as string);
  const ip = lanAddress();
  if (ip && ['localhost', '127.0.0.1'].includes(base.hostname)) base.hostname = ip;
  const phone = await openMap(browser, `${base.origin}/m`, { ...devices['Pixel 7'] });
  try {
    await phoneMatchesWall(phone);
  } finally {
    // The later tests use the wall only: a phone map left drawing WebGL in software slows them.
    await phone.context.close();
  }
});

async function phoneMatchesWall(phone: Opened): Promise<void> {
  /** When each page first showed a new fix of S1 (ms since epoch, test clock). */
  const seenAt = async (p: Page, after: string) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const s1 = (await fleet(p)).find((m) => m.unitNo === 'S1');
      if (s1 && s1.ts > after) return { at: Date.now(), ts: s1.ts };
      await p.waitForTimeout(100);
    }
    throw new Error('no new S1 fix within 45 s');
  };
  const start = new Date().toISOString();
  const [w, p] = await Promise.all([seenAt(wall.page, start), seenAt(phone.page, start)]);
  expect(p.ts).toBe(w.ts);
  expect(Math.abs(p.at - w.at), 'phone vs wall delay (ms)').toBeLessThan(2_000);

  // The phone has the whole fleet, with the same fixes as the wall at the same moment.
  const sameFixes = async () => {
    const [a, b] = await Promise.all([fleet(wall.page), fleet(phone.page)]);
    const byId = new Map(b.map((m) => [m.id, m.ts]));
    return a.filter((m) => byId.get(m.id) === m.ts).length === a.length && a.length === b.length;
  };
  await expect.poll(sameFixes, { timeout: 10_000 }).toBe(true);
  expect(phone.blocked, 'requests to non-local hosts').toEqual([]);
}

/** The largest distance (m) any machine moved between two looks at the map. */
function largestMove(before: FleetFrame[], after: FleetFrame[]): number {
  const moved = after.map((m) => {
    const b = before.find((x) => x.id === m.id);
    return b ? meters(b, m) : 0;
  });
  return Math.max(0, ...moved);
}

test('pausing the simulation freezes the fleet (still fresh); resuming moves it again', async () => {
  test.setTimeout(210_000);
  const page = wall.page;
  await admin(adminPage);
  await setPaused(adminPage, true);
  // Let the last pre-pause fixes arrive and their glides finish: the first Deere fix after the
  // pause lands within one 15 s poll, and a marker glides over the machine's own 15 s interval.
  // Under load a job run can land later than that, so after 30 s wait (up to a minute more)
  // until two looks 5 s apart agree: the fleet has settled. Then it must stay put for 20 s.
  await page.waitForTimeout(30_000);
  let before = await fleet(page);
  for (const settleBy = Date.now() + 60_000; Date.now() < settleBy; ) {
    await page.waitForTimeout(5_000);
    const now = await fleet(page);
    const settled = largestMove(before, now) < 0.1;
    before = now;
    if (settled) break;
  }
  await page.waitForTimeout(20_000);
  const after = await fleet(page);
  expect(largestMove(before, after), 'largest movement while paused (m)').toBeLessThan(1);
  expect(after.filter((m) => m.kind === 'semi' && m.stale)).toEqual([]);
  // Trucks keep reporting (fresh fixes, same place) while the simulation is paused.
  const s1Before = before.find((m) => m.unitNo === 'S1')?.ts ?? '';
  expect((after.find((m) => m.unitNo === 'S1')?.ts ?? '') > s1Before).toBe(true);

  await setPaused(adminPage, false);
  await expect
    .poll(
      async () => {
        const now = await fleet(page);
        return now.some((m) => {
          const b = after.find((x) => x.id === m.id);
          return b ? meters(b, m) > 5 : false;
        });
      },
      { timeout: 60_000, intervals: [2_000], message: 'something moves after resume' },
    )
    .toBe(true);
});

test('"trucks API down": the trucks go stale with a badge; off: they catch up', async () => {
  test.setTimeout(STALE_S * 1000 + 150_000);
  const page = wall.page;
  const semis = async () => (await fleet(page)).filter((m) => m.kind === 'semi');
  await admin(adminPage);
  await setTrucksDown(adminPage, true);
  const downAt = Date.now();

  await expect
    .poll(async () => (await semis()).filter((m) => m.stale).length, {
      timeout: STALE_S * 1000 + 60_000,
      intervals: [2_000],
      message: 'semis stale',
    })
    .toBe(4);
  await expect(page.getByTestId('badge-stale')).toBeVisible();
  await expect(page.getByTestId('badge-stale')).toContainText('stale');
  // Only the trucks: Deere keeps reporting the combines.
  expect((await fleet(page)).filter((m) => m.kind === 'combine' && m.stale)).toEqual([]);
  expect(Date.now() - downAt).toBeGreaterThan((STALE_S - 15) * 1000);

  await setTrucksDown(adminPage, false);
  await expect
    .poll(async () => (await semis()).filter((m) => m.stale).length, {
      timeout: 30_000,
      intervals: [1_000],
      message: 'semis fresh again',
    })
    .toBe(0);
  await expect(page.getByTestId('badge-stale')).toHaveCount(0);
  for (const m of await semis()) {
    expect(Date.now() - Date.parse(m.ts), `${m.unitNo} fix age (ms)`).toBeLessThan(30_000);
  }
  expect(wall.blocked, 'requests to non-local hosts').toEqual([]);
});
