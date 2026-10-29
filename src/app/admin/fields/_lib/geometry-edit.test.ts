import type { MultiPolygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import {
  deletePoint,
  fromMultiPolygon,
  insertPoint,
  midpointFeatures,
  movePoint,
  pointCount,
  shapeBounds,
  toMultiPolygon,
  vertexFeatures,
  vertexRefOf,
} from './geometry-edit';

const square: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  ],
};

describe('geometry-edit', () => {
  test('round-trips GeoJSON without the closing duplicate', () => {
    const s = fromMultiPolygon(square);
    expect(s).toEqual([
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    ]);
    expect(toMultiPolygon(s)).toEqual(square);
    expect(fromMultiPolygon(null)).toEqual([]);
    expect(pointCount(s)).toBe(4);
    expect(shapeBounds(s)).toEqual([0, 0, 1, 1]);
    expect(shapeBounds([])).toBeNull();
  });

  test('move, insert and delete points (a ring keeps three)', () => {
    let s = fromMultiPolygon(square);
    s = movePoint(s, { p: 0, r: 0, i: 2 }, [2, 2]);
    expect(s[0]?.[0]?.[2]).toEqual([2, 2]);
    s = insertPoint(s, { p: 0, r: 0, i: 1 }, [0.5, -0.5]);
    expect(s[0]?.[0]).toEqual([
      [0, 0],
      [0.5, -0.5],
      [1, 0],
      [2, 2],
      [0, 1],
    ]);
    const fewer = deletePoint(s, { p: 0, r: 0, i: 1 });
    expect(fewer?.[0]?.[0]).toHaveLength(4);
    const three = deletePoint(fewer ?? [], { p: 0, r: 0, i: 0 }) ?? [];
    expect(deletePoint(three, { p: 0, r: 0, i: 0 })).toBeNull();
    // Out of range refs change nothing.
    expect(movePoint(s, { p: 3, r: 0, i: 0 }, [9, 9])).toBe(s);
  });

  test('handles: one per vertex, one per edge midpoint (the closing edge too)', () => {
    const s = fromMultiPolygon(square);
    const v = vertexFeatures(s, { p: 0, r: 0, i: 1 });
    expect(v.features).toHaveLength(4);
    expect(v.features[1]?.properties).toEqual({ p: 0, r: 0, i: 1, selected: true });
    const m = midpointFeatures(s);
    expect(m.features).toHaveLength(4);
    expect(m.features[3]?.geometry.coordinates).toEqual([0, 0.5]);
    expect(m.features[3]?.properties).toEqual({ p: 0, r: 0, i: 4 });
    expect(vertexRefOf({ p: 0, r: '1', i: 2 })).toEqual({ p: 0, r: 1, i: 2 });
    expect(vertexRefOf({ p: 'x' })).toBeNull();
  });

  test('degenerate rings are dropped on the way out', () => {
    expect(
      toMultiPolygon([
        [
          [
            [0, 0],
            [1, 0],
          ],
        ],
      ]),
    ).toEqual({ type: 'MultiPolygon', coordinates: [] });
  });
});
