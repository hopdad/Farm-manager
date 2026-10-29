/**
 * Multi-touch gestures for e2e (plan §7 "Touch specifics"): dispatched TouchEvents, following
 * Playwright's touch-events guide. They are isTrusted=false, so the app must not filter on that
 * (MapLibre doesn't). Single taps use page.touchscreen.tap (trusted).
 */
import type { Locator } from '@playwright/test';

type Pt = { x: number; y: number };

async function centerOf(target: Locator): Promise<Pt> {
  return target.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

const touch = (identifier: number, p: Pt) => ({ identifier, clientX: p.x, clientY: p.y });

/** Move two fingers from `from` to `to` (interpolated over `steps` moves), then lift both. */
export async function twoFingerGesture(
  target: Locator,
  from: [Pt, Pt],
  to: [Pt, Pt],
  steps = 8,
): Promise<void> {
  const start = [touch(0, from[0]), touch(1, from[1])];
  await target.dispatchEvent('touchstart', {
    touches: start,
    changedTouches: start,
    targetTouches: start,
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = (k: 0 | 1): Pt => ({
      x: from[k].x + (to[k].x - from[k].x) * t,
      y: from[k].y + (to[k].y - from[k].y) * t,
    });
    const moved = [touch(0, p(0)), touch(1, p(1))];
    await target.dispatchEvent('touchmove', {
      touches: moved,
      changedTouches: moved,
      targetTouches: moved,
    });
  }
  const end = [touch(0, to[0]), touch(1, to[1])];
  await target.dispatchEvent('touchend', { touches: [], changedTouches: end, targetTouches: [] });
}

/** Pinch around the element's center: `scale` > 1 spreads the fingers (zoom in). */
export async function pinch(target: Locator, scale: number, startGap = 120): Promise<void> {
  const c = await centerOf(target);
  const a = startGap / 2;
  const b = (startGap * scale) / 2;
  await twoFingerGesture(
    target,
    [
      { x: c.x - a, y: c.y },
      { x: c.x + a, y: c.y },
    ],
    [
      { x: c.x - b, y: c.y },
      { x: c.x + b, y: c.y },
    ],
  );
}

/** Twist two fingers around the element's center by `degrees` (clockwise on screen). */
export async function rotate(target: Locator, degrees: number, radius = 100): Promise<void> {
  const c = await centerOf(target);
  const at = (deg: number, sign: 1 | -1): Pt => {
    const r = (deg * Math.PI) / 180;
    return { x: c.x + sign * radius * Math.cos(r), y: c.y + sign * radius * Math.sin(r) };
  };
  await twoFingerGesture(target, [at(0, -1), at(0, 1)], [at(degrees, -1), at(degrees, 1)], 12);
}

/** One-finger drag by (dx, dy) pixels. */
export async function pan(target: Locator, dx: number, dy: number, steps = 8): Promise<void> {
  const c = await centerOf(target);
  const start = [touch(0, c)];
  await target.dispatchEvent('touchstart', {
    touches: start,
    changedTouches: start,
    targetTouches: start,
  });
  for (let i = 1; i <= steps; i++) {
    const p = [touch(0, { x: c.x + (dx * i) / steps, y: c.y + (dy * i) / steps })];
    await target.dispatchEvent('touchmove', { touches: p, changedTouches: p, targetTouches: p });
  }
  const end = [touch(0, { x: c.x + dx, y: c.y + dy })];
  await target.dispatchEvent('touchend', { touches: [], changedTouches: end, targetTouches: [] });
}
