import { describe, expect, test } from 'vitest';
import { clipLine, clipRing } from './clip';

const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('clipLine', () => {
  test('keeps an inside line whole', () => {
    expect(
      clipLine(
        [
          [1, 1],
          [5, 5],
          [9, 1],
        ],
        box,
      ),
    ).toEqual([
      [
        [1, 1],
        [5, 5],
        [9, 1],
      ],
    ]);
  });

  test('cuts a crossing line at the box edges', () => {
    expect(
      clipLine(
        [
          [-10, 5],
          [20, 5],
        ],
        box,
      ),
    ).toEqual([
      [
        [0, 5],
        [10, 5],
      ],
    ]);
  });

  test('a line that leaves and re-enters becomes two pieces', () => {
    const pieces = clipLine(
      [
        [2, 2],
        [2, 20],
        [8, 20],
        [8, 2],
      ],
      box,
    );
    expect(pieces).toEqual([
      [
        [2, 2],
        [2, 10],
      ],
      [
        [8, 10],
        [8, 2],
      ],
    ]);
  });

  test('outside lines vanish', () => {
    expect(
      clipLine(
        [
          [20, 20],
          [30, 30],
        ],
        box,
      ),
    ).toEqual([]);
  });
});

describe('clipRing', () => {
  test('a big square becomes the box', () => {
    const ring = clipRing(
      [
        [-5, -5],
        [15, -5],
        [15, 15],
        [-5, 15],
        [-5, -5],
      ],
      box,
    );
    expect(ring).toHaveLength(4);
    expect(new Set(ring.map((p) => p.join(',')))).toEqual(
      new Set(['0,0', '10,0', '10,10', '0,10']),
    );
  });

  test('an outside ring vanishes, an inside ring is unchanged', () => {
    expect(
      clipRing(
        [
          [20, 20],
          [30, 20],
          [30, 30],
        ],
        box,
      ),
    ).toEqual([]);
    expect(
      clipRing(
        [
          [1, 1],
          [2, 1],
          [2, 2],
        ],
        box,
      ),
    ).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
  });
});
