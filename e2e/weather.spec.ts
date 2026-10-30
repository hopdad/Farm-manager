/**
 * Plan 1b done-when, in sim mode (CONNECTOR_WEATHER=sim, the NWS stand-in):
 *  - the weather strip renders on /board and /m with every non-local host blocked;
 *  - moving the simulated wind slider on /admin/spray flips the fields' spray colours on the map
 *    (feature state, read through the test-only window.__spray) with the reasons stored and
 *    shown;
 *  - a phone logs a soil temperature reading (driver and above); a viewer cannot.
 *
 * The wind slider changes the one shared stand-in, so that test runs in the `wall` project only
 * and puts the simulated weather back afterwards.
 */
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { getConfig } from '../src/config';
import { publish } from '../src/platform/realtime/publish';
import type { SprayMapResponse, WeatherStripPayload } from '../src/ui/weather/contract';
import type {} from '../src/ui/weather/SprayFieldState';
import { e2ePool, e2eUserId, signInAs } from './support/auth';
import { blockExternalHosts, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

const JOB_WAIT_MS = 60_000;
/**
 * The admin notice shows the action's answer as soon as it arrives (controls.tsx), but the
 * answer is a server round trip that pins the stand-in's wind and claims weather.nws: with map
 * specs drawing WebGL in software beside it (CI's other worker), that round trip alone took up
 * to 9 s here, beyond expect's 5 s default.
 */
const ANSWER_MS = 20_000;

/** Run weather.nws now (as the clock does) so the specs don't wait for the next tick. */
async function runWeatherJob(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/jobs/weather.nws', {
    headers: { authorization: `Bearer ${getConfig().JOBS_SECRET}` },
  });
  expect(res.status()).toBe(202);
}

/** The simulated weather knobs, straight to the stand-in (loopback, like the admin actions). */
async function simWeather(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${getConfig().VENDOR_SIM_URL}/_control/vendor/nws/weather`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function stripReady(request: APIRequestContext): Promise<WeatherStripPayload> {
  let strip: WeatherStripPayload | null = null;
  await expect
    .poll(
      async () => {
        await runWeatherJob(request).catch(() => {});
        const res = await request.get('/api/weather/strip');
        strip = res.ok() ? ((await res.json()) as WeatherStripPayload) : null;
        return strip?.issuedAt !== null && (strip?.days.length ?? 0) > 0;
      },
      { timeout: JOB_WAIT_MS, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
  return strip as unknown as WeatherStripPayload;
}

async function verdicts(request: APIRequestContext): Promise<SprayMapResponse> {
  const res = await request.get('/api/weather/spray');
  expect(res.status()).toBe(200);
  return (await res.json()) as SprayMapResponse;
}

/** Move the wind slider (retried until the hydrated page shows the value). */
async function setSlider(page: Page, mph: number): Promise<void> {
  await expect(async () => {
    await page.getByTestId('sim-wind').fill(String(mph));
    await expect(page.getByTestId('sim-wind-value')).toHaveText(String(mph), { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** `seen` resolves when this page's realtime stream (EventSource) delivers a `topic` message. */
async function realtimeMessage(page: Page, topic: string): Promise<{ seen: Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const match = new RegExp(`"topic"\\s*:\\s*"${topic}"`);
  const seen = new Promise<void>((resolve) => {
    cdp.on('Network.eventSourceMessageReceived', (e) => {
      if (match.test(e.data)) resolve();
    });
  });
  return { seen };
}

/**
 * Slow down /admin/spray's router on this page: a server action goes out only 1 s after `gate`
 * resolves, and page refreshes (RSC GETs that are not prefetches) are held until `release()`.
 */
async function slowRouter(page: Page, gate: Promise<void>) {
  let release: () => void = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held = 0;
  const handler = async (route: Route) => {
    const req = route.request();
    const h = req.headers();
    if (h['next-action']) {
      await gate;
      await new Promise((r) => setTimeout(r, 1_000));
    } else if (req.method() === 'GET' && h.rsc === '1' && !h['next-router-prefetch']) {
      held++;
      await released;
    }
    await route.continue().catch(() => {}); // the page may be gone by then
  };
  await page.route('**/admin/spray**', handler);
  return {
    held: () => held,
    release: async () => {
      release();
      await page.unroute('**/admin/spray**', handler);
    },
  };
}

/** Feature-state verdict of every field the map was given. */
function mapVerdicts(page: Page) {
  return page.evaluate(() => {
    const s = window.__spray;
    if (!s) return null;
    return Object.keys(s.verdicts()).map((id) => s.featureState(id));
  });
}

test('the strip renders offline from the stored forecast (sim)', async ({
  page,
  context,
  request,
  baseURL,
}, testInfo) => {
  await signInAs(context);
  const strip = await stripReady(request);
  expect(strip.mode).toBe('sim');
  expect(strip.days.length).toBeGreaterThanOrEqual(3);
  expect(strip.days[0]?.label).toBe('Today');

  const blocked = await blockExternalHosts(page, baseURL);
  await page.goto(mapPathFor(testInfo));
  await waitForMap(page);
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('weather-chip').click();
    await expect(page.getByTestId('weather-sheet')).toBeVisible();
    await expect(page.getByTestId('weather-day')).toHaveCount(strip.days.length);
  } else {
    const el = page.getByTestId('weather-strip');
    await expect(el).toHaveAttribute('data-state', 'ready');
    await expect(el.getByTestId('weather-day')).toHaveCount(strip.days.length);
    await expect(el.getByTestId('weather-hour').first()).toBeVisible();
    await expect(el.getByText('Simulated weather')).toBeVisible();
    await expect(page.getByTestId('spray-toggle')).toContainText(/Advisory/);
  }
  expect(blocked, 'requests to non-local hosts').toEqual([]);
});

test.describe('the wind slider', () => {
  test.describe.configure({ timeout: 180_000 });

  test('flips the field colours on the map, with reasons', async ({
    page,
    context,
    browser,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'wall', 'one shared stand-in: the wall project drives it');
    try {
      await windSliderFlips(page, context, browser, request);
    } finally {
      await simWeather({ windMph: null, pattern: null });
    }
  });

  test('a viewer cannot open the thresholds page', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await signInAs(ctx);
    const p = await ctx.newPage();
    await p.goto('/admin/spray');
    await expect(p.getByTestId('spray-admin-refused')).toBeVisible();
    await ctx.close();
  });
});

async function windSliderFlips(
  page: Page,
  context: BrowserContext,
  browser: Browser,
  request: APIRequestContext,
): Promise<void> {
  await signInAs(context, 'manager');
  await stripReady(request);

  // The board (a viewer's screen) with the map's spray state.
  const board = await browser.newContext();
  await signInAs(board);
  const wall = await board.newPage();
  await wall.goto('/board');
  await waitForMap(wall);
  await wall.waitForFunction(() => !!window.__spray, null, { timeout: 30_000 });

  // Manager: pin the wind at 20 mph on a calm day.
  await page.goto('/admin/spray');
  await expect(page.getByTestId('spray-advisory')).toContainText(
    "defaults pending Derrick's values",
  );
  await page.getByTestId('sim-pattern').selectOption('calm');
  await setSlider(page, 20);
  await page.getByTestId('sim-weather-apply').click();
  await expect(page.getByTestId('admin-notice')).toContainText('wind pinned at 20 mph', {
    timeout: ANSWER_MS,
  });

  await expect
    .poll(
      async () => {
        const v = await verdicts(request);
        return v.fields.length > 0 && v.fields.every((f) => f.verdict === 'no_go');
      },
      { timeout: JOB_WAIT_MS },
    )
    .toBe(true);
  await expect
    .poll(() => mapVerdicts(wall), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['no_go']));
  expect((await mapVerdicts(wall))?.every((v) => v === 'no_go')).toBe(true);
  await expect(wall.getByTestId('spray-counts')).toContainText('0 go');

  // The reasons: stored per field and shown to the manager.
  const one = (await verdicts(request)).fields[0]?.fieldId as string;
  const field = await (await request.get(`/api/weather/spray/${one}`)).json();
  expect(field.hours[0].reasons.map((r: { code: string }) => r.code)).toEqual(
    expect.arrayContaining(['wind_high', 'gust_high']),
  );
  await page.reload();
  await expect(page.getByTestId('spray-verdict-row').first()).toContainText(
    /Wind 2\d mph \(limit 10\)/,
  );

  // Back down to 5 mph: the colours flip back, no wind reasons.
  await setSlider(page, 5);
  await page.getByTestId('sim-weather-apply').click();
  await expect(page.getByTestId('admin-notice')).toContainText('wind pinned at 5 mph', {
    timeout: ANSWER_MS,
  });
  await expect
    .poll(async () => (await verdicts(request)).fields.every((f) => f.verdict !== 'no_go'), {
      timeout: JOB_WAIT_MS,
    })
    .toBe(true);
  await expect
    .poll(async () => (await mapVerdicts(wall))?.some((v) => v === 'no_go'), { timeout: 30_000 })
    .toBe(false);
  const after = await (await request.get(`/api/weather/spray/${one}`)).json();
  expect(after.hours[0].reasons.map((r: { code: string }) => r.code)).not.toContain('wind_high');

  // Back to the scenario's weather while a page refresh is stuck: the confirmation must not wait
  // for it. (It did: the notice came from useActionState, which React commits only together with
  // every router refresh started while the action ran, like LiveRefresh's on a realtime event.)
  // The action goes out only once a weather event has reached the page and LiveRefresh has
  // started its refresh; that refresh, queued behind the action, is held until the end.
  const weather = await realtimeMessage(page, 'weather');
  const router = await slowRouter(page, weather.seen);
  try {
    await page.getByTestId('sim-weather-clear').click();
    await publish('weather', 'invalidate', { event: 'updated', reason: 'changed' }, e2ePool());
    await expect(page.getByTestId('admin-notice')).toContainText('follows the', {
      timeout: ANSWER_MS,
    });
    await expect
      .poll(router.held, { message: 'the refresh behind the action is held' })
      .toBeGreaterThan(0);
    await expect(page.getByTestId('admin-notice')).toContainText('follows the');
  } finally {
    await router.release();
  }
  await board.close();
}

test.describe('soil temperature from a phone', () => {
  test('a driver logs a reading; the strip shows it with its age', async ({
    page,
    context,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'the phone form');
    await signInAs(context, 'driver');
    await stripReady(request);
    await page.goto('/m');
    await page.getByTestId('weather-chip').click();
    await page.getByTestId('soil-temp-open').click();
    await page.getByTestId('soil-temp-value').fill('47.6');
    await page.getByTestId('soil-temp-depth').selectOption('4');
    await page.getByTestId('soil-temp-save').click();
    await expect(page.getByTestId('soil-temp-message')).toHaveText('Saved 48°');
    try {
      await expect(page.getByTestId('weather-soil')).toContainText('48°', { timeout: 15_000 });
      await expect(page.getByTestId('weather-soil')).toContainText(/4 in · (just now|\d+ min ago)/);
    } finally {
      // A test reading never stays in the dev database (it would travel with data:export).
      await e2ePool().query(
        `delete from farm.soil_temp_readings where entered_by = $1::uuid and temp_f = 47.6`,
        [e2eUserId('driver')],
      );
    }
  });

  test('a viewer is refused, on the page and by the server', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'the phone form');
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await signInAs(ctx);
    const page = await ctx.newPage();
    await page.goto('/m');
    await page.getByTestId('weather-chip').click();
    await page.getByTestId('soil-temp-open').click();
    await expect(page.getByTestId('soil-temp-refused')).toBeVisible();
    const res = await page.request.post('/api/weather/soil-temp', {
      data: { tempF: 50 },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(403);
    await ctx.close();
  });
});
