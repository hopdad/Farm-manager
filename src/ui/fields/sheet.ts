/**
 * The phone bottom sheet's snap points (pure; unit-tested). The sheet is as tall as its `full`
 * height and slides: its visible height is one of three snaps, or wherever a drag holds it.
 *
 *   peek  the header (name, acres, tenure): the map stays usable
 *   half  header plus the start of the overview (where it opens)
 *   full  everything, leaving the status strip visible
 *
 * A drag that ends settles on the nearest snap, or one further in the direction of a flick; a
 * flick down from the peek height, or a drag well below it, closes the panel.
 */

export const SHEET_SNAPS = ['peek', 'half', 'full'] as const;
export type SheetSnap = (typeof SHEET_SNAPS)[number];

export const SHEET_OPEN_SNAP: SheetSnap = 'half';

/** px/ms: faster than this at release counts as a flick. */
export const FLICK_VELOCITY = 0.5;

/** Space kept above the full sheet (the phone status strip is 52 px). */
export const SHEET_TOP_GAP = 60;

export type SheetHeights = Record<SheetSnap, number>;

/** Visible heights for a viewport of `viewportHeight` CSS px (always peek < half < full). */
export function snapHeights(viewportHeight: number): SheetHeights {
  const vh = Math.max(320, viewportHeight);
  const full = vh - SHEET_TOP_GAP;
  const peek = Math.min(Math.max(Math.round(vh * 0.2), 132), 180);
  const half = Math.min(Math.max(Math.round(vh * 0.55), peek + 80), full - 40);
  return { peek, half, full };
}

/** Clamp a dragged height: never above full; below peek it may sink (towards closing). */
export function clampDrag(heights: SheetHeights, visible: number): number {
  return Math.min(heights.full, Math.max(0, visible));
}

/**
 * Where a released drag settles. `velocity` is px/ms of the sheet's top edge, positive when
 * moving DOWN (the sheet shrinking).
 */
export function settleSnap(
  heights: SheetHeights,
  visible: number,
  velocity: number,
): SheetSnap | 'close' {
  const order = SHEET_SNAPS.map((s) => ({ snap: s, h: heights[s] }));
  if (visible < heights.peek * 0.6) return 'close';
  if (velocity > FLICK_VELOCITY) {
    // Flick down: the next snap below the current position (or close below the peek).
    const below = [...order].reverse().find((o) => o.h < visible - 1);
    return below ? below.snap : 'close';
  }
  if (velocity < -FLICK_VELOCITY) {
    const above = order.find((o) => o.h > visible + 1);
    return above ? above.snap : 'full';
  }
  let best = order[0] as { snap: SheetSnap; h: number };
  for (const o of order) if (Math.abs(o.h - visible) < Math.abs(best.h - visible)) best = o;
  return best.snap;
}

/** Keyboard: one snap up or down (stays at the ends; closing is the X or Escape). */
export function stepSnap(current: SheetSnap, direction: 1 | -1): SheetSnap {
  const i = SHEET_SNAPS.indexOf(current) + direction;
  return SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, Math.max(0, i))] as SheetSnap;
}

/** A tap on the handle: peek → half → full → half … (the most useful toggle). */
export function toggleSnap(current: SheetSnap): SheetSnap {
  return current === 'full' ? 'half' : current === 'half' ? 'full' : 'half';
}

export const SNAP_LABELS: Record<SheetSnap, string> = {
  peek: 'collapsed',
  half: 'half open',
  full: 'fully open',
};
