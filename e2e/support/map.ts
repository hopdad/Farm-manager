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

declare global {
  interface Window {
    /** Installed by installFakeRealtime(): deliver a message to subscribers of `topic`. */
    __fleetEmit?: (
      topic: string,
      message: { event: string; payload: unknown; seq: number },
    ) => void;
    __fleetResyncs?: number;
    /** Installed by installFakeRealtime(): what the real client does after a reconnect. */
    __fleetResync?: () => void;
  }
}

/**
 * Replace the realtime client with a test double before the app loads (outside production the
 * map uses `window.__farmTestRealtime` when present). It calls onResync once on subscribe, like
 * the real client after connecting, and window.__fleetEmit() delivers events.
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
          window.__fleetResyncs = (window.__fleetResyncs ?? 0) + 1;
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
        window.__fleetResyncs = (window.__fleetResyncs ?? 0) + 1;
        s.opts.onResync();
      }
    };
    window.__fleetEmit = (topic, message) => {
      for (const s of subs) if (s.topic === topic) s.onEvent(message);
    };
  });
}
