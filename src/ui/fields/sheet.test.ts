import { describe, expect, test } from 'vitest';
import {
  clampDrag,
  FLICK_VELOCITY,
  SHEET_TOP_GAP,
  settleSnap,
  snapHeights,
  stepSnap,
  toggleSnap,
} from './sheet';

describe('snapHeights', () => {
  test('peek < half < full on phones of every size', () => {
    for (const vh of [320, 568, 667, 780, 839, 932, 1366]) {
      const h = snapHeights(vh);
      expect(h.peek).toBeLessThan(h.half);
      expect(h.half).toBeLessThan(h.full);
      expect(h.full).toBe(Math.max(320, vh) - SHEET_TOP_GAP);
      expect(h.peek).toBeGreaterThanOrEqual(132);
    }
  });

  test('a Pixel 7 (839 px tall)', () => {
    expect(snapHeights(839)).toEqual({ peek: 168, half: 461, full: 779 });
  });
});

describe('settleSnap', () => {
  const h = snapHeights(839);

  test('a slow release settles on the nearest snap', () => {
    expect(settleSnap(h, 170, 0)).toBe('peek');
    expect(settleSnap(h, 300, 0)).toBe('peek');
    expect(settleSnap(h, 330, 0)).toBe('half');
    expect(settleSnap(h, 600, 0.1)).toBe('half');
    expect(settleSnap(h, 700, -0.1)).toBe('full');
  });

  test('a flick goes one snap further in its direction', () => {
    const v = FLICK_VELOCITY + 0.1;
    expect(settleSnap(h, 470, -v)).toBe('full');
    expect(settleSnap(h, 300, -v)).toBe('half');
    expect(settleSnap(h, 455, v)).toBe('peek');
    expect(settleSnap(h, 700, v)).toBe('half');
    expect(settleSnap(h, 800, -v)).toBe('full');
  });

  test('a flick down from the peek, or a drag far below it, closes', () => {
    expect(settleSnap(h, h.peek - 5, FLICK_VELOCITY + 0.1)).toBe('close');
    expect(settleSnap(h, h.peek * 0.5, 0)).toBe('close');
    expect(settleSnap(h, h.peek * 0.7, 0)).toBe('peek');
  });
});

describe('keyboard and taps', () => {
  test('arrow keys step and stop at the ends', () => {
    expect(stepSnap('peek', 1)).toBe('half');
    expect(stepSnap('half', 1)).toBe('full');
    expect(stepSnap('full', 1)).toBe('full');
    expect(stepSnap('half', -1)).toBe('peek');
    expect(stepSnap('peek', -1)).toBe('peek');
  });

  test('a tap toggles between half and full; from peek it opens to half', () => {
    expect(toggleSnap('peek')).toBe('half');
    expect(toggleSnap('half')).toBe('full');
    expect(toggleSnap('full')).toBe('half');
  });

  test('drags are clamped to the full height and to zero', () => {
    const h = snapHeights(839);
    expect(clampDrag(h, 5000)).toBe(h.full);
    expect(clampDrag(h, -20)).toBe(0);
    expect(clampDrag(h, 300)).toBe(300);
  });
});
