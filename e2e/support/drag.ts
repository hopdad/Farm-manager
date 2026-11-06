/**
 * Drag helpers for the job board's e2e (slice 2a; docs/contracts-2a.md §8). INTEGRATOR-OWNED
 * (e2e/support/**): builders use them, and ask in their report for anything else.
 *
 *  - `touchDrag`: a TRUSTED single-finger drag through a Chromium CDP session
 *    (`Input.dispatchTouchEvent`, plan §7 "Touch specifics": drag-to-assign uses trusted touch).
 *    It presses, HOLDS STILL for `holdMs` (dnd-kit's TouchSensor waits 200 ms with an 8 px
 *    tolerance before a drag starts), moves in `steps`, rests on the target, then lifts.
 *    Chromium only (the wall and phone projects are Chromium).
 *  - `mouseDrag`: press, a small nudge past the MouseSensor's 6 px activation distance, move in
 *    steps, rest, release.
 *  - `dragTo`: either of them from one locator's centre to another's (or to a point).
 *  - `mapPoint`: the viewport point of a lng/lat on the board's map (`window.__map.project`),
 *    for a drop on a field.
 *
 * Coordinates are viewport CSS pixels (what boundingBox and __map.project return). A self-test
 * is e2e/drag-helpers.spec.ts.
 */
import type { CDPSession, Locator, Page } from '@playwright/test';

export interface Pt {
  x: number;
  y: number;
}

export interface TouchDragOptions {
  /** Hold still after the press before the first move (TouchSensor delay 200 ms). Default 350. */
  holdMs?: number;
  /** Moves from start to end. Default 12. */
  steps?: number;
  /** Pause between moves. Default 16 ms (about a frame). */
  stepMs?: number;
  /** Rest on the target before lifting (droppables see the pointer over them). Default 150. */
  settleMs?: number;
  /** A CDP session of this page to reuse (one is opened per call otherwise). */
  cdp?: CDPSession;
}

export interface MouseDragOptions {
  /** Moves from start to end after the nudge. Default 12. */
  steps?: number;
  stepMs?: number;
  settleMs?: number;
  /** The first small move that activates the MouseSensor (6 px). Default 10. */
  nudgePx?: number;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** The centre of a locator, in viewport CSS px. */
export async function centerOf(target: Locator): Promise<Pt> {
  const box = await target.boundingBox();
  if (!box) throw new Error('drag: the element has no box (hidden or detached)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where a WGS84 point is on the board's map, in viewport CSS px. */
export async function mapPoint(page: Page, lngLat: { lng: number; lat: number }): Promise<Pt> {
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat) ?? null, lngLat);
  if (!p) throw new Error('drag: the map is not ready (window.__map)');
  return p;
}

/** A trusted one-finger drag from `from` to `to` (see the header). */
export async function touchDrag(
  page: Page,
  from: Pt,
  to: Pt,
  opts: TouchDragOptions = {},
): Promise<void> {
  const holdMs = opts.holdMs ?? 350;
  const steps = Math.max(1, opts.steps ?? 12);
  const stepMs = opts.stepMs ?? 16;
  const settleMs = opts.settleMs ?? 150;
  const cdp = opts.cdp ?? (await page.context().newCDPSession(page));
  const point = (p: Pt) => ({ x: p.x, y: p.y, id: 0, radiusX: 4, radiusY: 4, force: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    await page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [point(lerp(from, to, i / steps))],
      });
      if (stepMs > 0) await page.waitForTimeout(stepMs);
    }
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    if (!opts.cdp) await cdp.detach().catch(() => {});
  }
}

/** A mouse drag from `from` to `to` (see the header). */
export async function mouseDrag(
  page: Page,
  from: Pt,
  to: Pt,
  opts: MouseDragOptions = {},
): Promise<void> {
  const steps = Math.max(1, opts.steps ?? 12);
  const stepMs = opts.stepMs ?? 16;
  const settleMs = opts.settleMs ?? 150;
  const nudge = opts.nudgePx ?? 10;
  // The nudge goes towards the target, so it never moves away first.
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const start: Pt = {
    x: from.x + ((to.x - from.x) / len) * nudge,
    y: from.y + ((to.y - from.y) / len) * nudge,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y);
  for (let i = 1; i <= steps; i++) {
    const p = lerp(start, to, i / steps);
    await page.mouse.move(p.x, p.y);
    if (stepMs > 0) await page.waitForTimeout(stepMs);
  }
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await page.mouse.up();
}

/** Drag `source` (a job card) onto `target` (a chip, or a map point) with touch or the mouse. */
export async function dragTo(
  page: Page,
  source: Locator,
  target: Locator | Pt,
  opts: { pointer?: 'touch' | 'mouse' } & TouchDragOptions & MouseDragOptions = {},
): Promise<void> {
  const from = await centerOf(source);
  const to = 'x' in target ? target : await centerOf(target);
  if ((opts.pointer ?? 'touch') === 'mouse') await mouseDrag(page, from, to, opts);
  else await touchDrag(page, from, to, opts);
}
