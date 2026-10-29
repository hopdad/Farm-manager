/**
 * Fit padding that keeps fields out from under the board's panels (the morning glance): the
 * layer rail on the left, the fleet or field panel on the right, the weather strip at the bottom
 * (wall); the field sheet at the bottom (phone). Panels mark their root with `data-dock="left" |
 * "right" | "bottom"`; the padding is measured from what is actually on screen, so it follows the
 * rail being closed, a field being open and the display's scaling. Pure apart from the rects it
 * is given (unit-tested with plain objects).
 */

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Dock = 'left' | 'right' | 'bottom';

/** Each side's padding: `base`, or what a docked panel covers plus `gap`. */
export function dockInsets(
  map: Rect,
  docked: readonly { dock: Dock; rect: Rect }[],
  base: Insets,
  gap: number,
): Insets {
  const out = { ...base };
  for (const { dock, rect } of docked) {
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) continue;
    if (dock === 'left') out.left = Math.max(out.left, rect.right - map.left + gap);
    else if (dock === 'right') out.right = Math.max(out.right, map.right - rect.left + gap);
    else out.bottom = Math.max(out.bottom, map.bottom - rect.top + gap);
  }
  // Never squeeze the fields into less than a third of the map (a small window, a phone sheet
  // pulled up): scale the padding down instead.
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  const shrink = (a: number, b: number, size: number): [number, number] => {
    const max = (size * 2) / 3;
    if (a + b <= max || a + b === 0) return [a, b];
    const k = max / (a + b);
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  [out.left, out.right] = shrink(out.left, out.right, width);
  [out.top, out.bottom] = shrink(out.top, out.bottom, height);
  return out;
}

/** The docked panels inside `area` (the board's map area), measured now. */
export function measureDocked(area: ParentNode): { dock: Dock; rect: Rect }[] {
  const out: { dock: Dock; rect: Rect }[] = [];
  for (const el of area.querySelectorAll<HTMLElement>('[data-dock]')) {
    const dock = el.dataset.dock;
    if (dock !== 'left' && dock !== 'right' && dock !== 'bottom') continue;
    const r = el.getBoundingClientRect();
    out.push({ dock, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  }
  return out;
}

/** Base padding per screen: the map controls sit on the right; the phone's buttons top left. */
export const BASE_FIT_PADDING: Record<'wall' | 'phone', Insets> = {
  wall: { top: 80, right: 112, bottom: 48, left: 48 },
  phone: { top: 120, right: 72, bottom: 16, left: 16 },
};
