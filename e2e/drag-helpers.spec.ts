/**
 * Self-test of e2e/support/drag.ts (slice 2a foundation; docs/contracts-2a.md §8): the trusted
 * touch drag presses, holds for the TouchSensor delay, moves in steps and lifts, all as trusted
 * events; the mouse drag passes the MouseSensor's activation distance. On a blank page (no app),
 * so it checks the helpers, not the board.
 */
import { expect, test } from '@playwright/test';
import { mouseDrag, touchDrag } from './support/drag';

interface Seen {
  type: string;
  trusted: boolean;
  t: number;
  x: number | null;
  y: number | null;
}

declare global {
  interface Window {
    __seen?: Seen[];
  }
}

const PAD = `<!doctype html><html><body style="margin:0">
  <div id="pad" style="position:fixed;inset:0;touch-action:none;background:#eee"></div>
  </body></html>`;

async function record(page: import('@playwright/test').Page, types: string[]): Promise<void> {
  await page.setContent(PAD);
  await page.evaluate((list) => {
    window.__seen = [];
    for (const type of list) {
      document.addEventListener(
        type,
        (e) => {
          const p =
            e instanceof TouchEvent
              ? (e.changedTouches[0] ?? null)
              : e instanceof MouseEvent
                ? e
                : null;
          window.__seen?.push({
            type: e.type,
            trusted: e.isTrusted,
            t: performance.now(),
            x: p ? p.clientX : null,
            y: p ? p.clientY : null,
          });
        },
        { capture: true, passive: true },
      );
    }
  }, types);
}

test('touchDrag: trusted press, a hold, moves in steps, lift', async ({ page }) => {
  await record(page, ['touchstart', 'touchmove', 'touchend', 'touchcancel']);
  const before = Date.now();
  const { releasedAt } = await touchDrag(
    page,
    { x: 100, y: 120 },
    { x: 300, y: 220 },
    { holdMs: 300, steps: 5 },
  );
  // The done-when's clock starts at the lift: after the hold and the moves, not before.
  expect(releasedAt - before).toBeGreaterThanOrEqual(300);
  expect(releasedAt).toBeLessThanOrEqual(Date.now());
  const seen = (await page.evaluate(() => window.__seen)) ?? [];
  expect(seen.map((e) => e.type)).toEqual([
    'touchstart',
    'touchmove',
    'touchmove',
    'touchmove',
    'touchmove',
    'touchmove',
    'touchend',
  ]);
  expect(seen.every((e) => e.trusted)).toBe(true);
  const [start, firstMove] = seen;
  // The TouchSensor (delay 200 ms) needs the finger still that long before the first move.
  expect((firstMove?.t ?? 0) - (start?.t ?? 0)).toBeGreaterThanOrEqual(250);
  // Device pixel ratios that aren't whole (Pixel 7: 2.625) round the CSS coordinates a little.
  expect(start?.x).toBeCloseTo(100, 1);
  expect(start?.y).toBeCloseTo(120, 1);
  const last = seen[seen.length - 2];
  expect(last?.x).toBeCloseTo(300, 0);
  expect(last?.y).toBeCloseTo(220, 0);
});

test('mouseDrag: press, past the 6 px activation distance, moves, release', async ({ page }) => {
  await record(page, ['mousedown', 'mousemove', 'mouseup']);
  await mouseDrag(page, { x: 400, y: 300 }, { x: 600, y: 300 }, { steps: 4, nudgePx: 10 });
  const seen = (await page.evaluate(() => window.__seen)) ?? [];
  const types = seen.map((e) => e.type);
  expect(types[0] === 'mousedown' || types[1] === 'mousedown').toBe(true);
  expect(types[types.length - 1]).toBe('mouseup');
  const down = seen.find((e) => e.type === 'mousedown');
  const afterDown = seen.slice(seen.indexOf(down as Seen) + 1, -1);
  expect(afterDown.length).toBeGreaterThanOrEqual(5);
  expect(Math.abs((afterDown[0]?.x ?? 0) - 400)).toBeGreaterThanOrEqual(6);
  expect(seen.every((e) => e.trusted)).toBe(true);
  const up = seen[seen.length - 1];
  expect(up?.x).toBeCloseTo(600, 1);
  expect(up?.y).toBeCloseTo(300, 1);
});
