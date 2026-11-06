/**
 * Shared e2e helpers for the war-room map. Assertions go through the test-only `window.__map`
 * (src/ui/map/test-api.ts), not pixels (plan §7).
 */
import type { Page, TestInfo } from '@playwright/test';
import type { RealtimeClient } from '../../src/platform/realtime/types';
import type {} from '../../src/ui/map/test-api';

/**
 * MapLibre 6 needs WebGL2. Headless Chromium on CI and in containers only has SwiftShader,
 * which Chrome now enables for WebGL only with this flag (plan §7 CI notes).
 */
export const WEBGL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The `wall` project tests /board; `phone` tests /m. */
export function mapPathFor(testInfo: TestInfo): '/board' | '/m' {
  return testInfo.project.name === 'phone' ? '/m' : '/board';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Abort every request to a host other than the app's own (and loopback). Returns the list of
 * blocked URLs, which a test can assert is empty: the board must work with the internet gone.
 */
export async function blockExternalHosts(
  page: Page,
  baseURL: string | undefined,
): Promise<string[]> {
  const own = baseURL ? new URL(baseURL).host : null;
  const blocked: string[] = [];
  await page.context().route(
    (url) => !(LOCAL_HOSTS.has(url.hostname) || url.host === own),
    async (route) => {
      blocked.push(route.request().url());
      await route.abort('blockedbyclient');
    },
  );
  return blocked;
}

/** Wait until the map's style is loaded and window.__map is installed. */
export async function waitForMap(page: Page, timeout = 45_000): Promise<void> {
  await page.waitForFunction(() => window.__map?.loaded() === true, null, { timeout });
}

/** Wait for MapLibre's next 'idle' (everything requested has rendered). */
export async function mapIdle(page: Page): Promise<void> {
  await page.evaluate(() => window.__map?.idle(20_000));
}

/**
 * The wall: before a tap on the map, make sure the point is in the map's FREE area, between the
 * top of the war-room map and the top of the weather strip docked at the screen's bottom; if it
 * is closer than `marginPx` to either edge, jump the map so the point sits in the middle of that
 * area. The rows above the map (the slice 2a jobs band, contracts-2a §7.1) shrink the map area
 * and move its centre down, while the strip stays at the bottom, so a tap aimed near the centre
 * could land on the strip. A no-op where there is no docked strip (phones: revealAboveSheet /
 * revealAbovePanel in the specs) and when the point is already well inside. Returns whether the
 * map moved (it then waits for the map to be idle).
 */
export async function revealInFreeMap(
  page: Page,
  lngLat: { lng: number; lat: number },
  opts: { marginPx?: number } = {},
): Promise<boolean> {
  const margin = opts.marginPx ?? 48;
  const strip = page.locator('[data-testid="weather-strip"][data-dock="bottom"]');
  const stripBox = (await strip.count()) > 0 ? await strip.first().boundingBox() : null;
  const mapBox = await page.getByTestId('war-room-map').boundingBox();
  if (!stripBox || !mapBox || stripBox.y <= mapBox.y) return false;
  const top = mapBox.y;
  const bottom = stripBox.y;
  const moved = await page.evaluate(
    ({ c, top, bottom, margin }) => {
      const m = window.__map;
      if (!m) return false;
      const p = m.project(c.lng, c.lat);
      if (p.y >= top + margin && p.y <= bottom - margin) return false;
      const targetY = (top + bottom) / 2;
      const pxPerDegLat = p.y - m.project(c.lng, c.lat + 0.001).y;
      if (!(pxPerDegLat > 0)) return false;
      const centre = m.center();
      m.jumpTo({ center: [centre.lng, centre.lat - ((p.y - targetY) / pxPerDegLat) * 0.001] });
      return true;
    },
    { c: lngLat, top, bottom, margin },
  );
  if (moved) await mapIdle(page);
  return moved;
}

declare global {
  interface Window {
    /** Installed by installFakeRealtime(): deliver a message to subscribers of `topic`. */
    __fleetEmit?: (
      topic: string,
      message: { event: string; payload: unknown; seq: number },
    ) => void;
    /** Resyncs delivered to `fleet` subscribers (other topics don't count). */
    __fleetResyncs?: number;
    /** Installed by installFakeRealtime(): what the real client does after a reconnect. */
    __fleetResync?: () => void;
  }
}

/**
 * Replace the realtime client with a test double before the app loads (outside production the
 * map uses `window.__farmTestRealtime` when present). It calls onResync once on subscribe, like
 * the real client after connecting, and window.__fleetEmit() delivers events to every topic's
 * subscribers (`fleet`, `fields`, `jobs`, …). `window.__fleetResyncs` counts the resyncs of
 * `fleet` subscriptions only (contracts-2a §7.1): other subscribers on the page (the job board
 * subscribes `jobs` on mount) don't move it.
 */
export async function installFakeRealtime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Sub = { topic: string; onEvent(evt: unknown): void; opts: { onResync(): void } };
    const subs: Sub[] = [];
    window.__fleetResyncs = 0;
    const client = {
      subscribe(topic: string, onEvent: (evt: unknown) => void, opts: { onResync(): void }) {
        const sub: Sub = { topic, onEvent, opts };
        subs.push(sub);
        queueMicrotask(() => {
          if (topic === 'fleet') window.__fleetResyncs = (window.__fleetResyncs ?? 0) + 1;
          opts.onResync();
        });
        return () => {
          const i = subs.indexOf(sub);
          if (i >= 0) subs.splice(i, 1);
        };
      },
    };
    window.__farmTestRealtime = client as unknown as RealtimeClient;
    window.__fleetResync = () => {
      for (const s of subs) {
        if (s.topic === 'fleet') window.__fleetResyncs = (window.__fleetResyncs ?? 0) + 1;
        s.opts.onResync();
      }
    };
    window.__fleetEmit = (topic, message) => {
      for (const s of subs) if (s.topic === topic) s.onEvent(message);
    };
  });
}
