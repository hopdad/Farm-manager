/** Fit padding clear of the docked panels. */
import { describe, expect, test } from 'vitest';
import { BASE_FIT_PADDING, dockInsets } from './fit';

/** The wall's map area at 1920x1080 CSS px, under the 72 px strip. */
const MAP = { left: 0, top: 72, right: 1920, bottom: 1080 };

describe('dockInsets', () => {
  test('the rail, the fleet panel and the weather strip all push the fit inwards', () => {
    const p = dockInsets(
      MAP,
      [
        { dock: 'left', rect: { left: 16, top: 88, right: 428, bottom: 1064 } },
        { dock: 'right', rect: { left: 1364, top: 88, right: 1824, bottom: 700 } },
        { dock: 'bottom', rect: { left: 444, top: 790, right: 1824, bottom: 1064 } },
      ],
      BASE_FIT_PADDING.wall,
      16,
    );
    expect(p).toEqual({ top: 80, left: 444, right: 572, bottom: 306 });
  });

  test('closed or empty panels count for nothing; the base padding stays', () => {
    const p = dockInsets(
      MAP,
      [{ dock: 'left', rect: { left: 0, top: 0, right: 0, bottom: 0 } }],
      BASE_FIT_PADDING.wall,
      16,
    );
    expect(p).toEqual(BASE_FIT_PADDING.wall);
  });

  test('never squeezes the fields into less than a third of a small map', () => {
    const small = { left: 0, top: 0, right: 900, bottom: 600 };
    const p = dockInsets(
      small,
      [
        { dock: 'left', rect: { left: 0, top: 0, right: 430, bottom: 600 } },
        { dock: 'right', rect: { left: 440, top: 0, right: 900, bottom: 600 } },
      ],
      BASE_FIT_PADDING.wall,
      16,
    );
    expect(p.left + p.right).toBeLessThanOrEqual(600);
    expect(p.left).toBeGreaterThan(0);
  });
});
