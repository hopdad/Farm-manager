import { describe, expect, test } from 'vitest';
import {
  type BatchLimits,
  chunkKeys,
  compareKeys,
  DEFAULT_LIMITS,
  estimateBytes,
  type MukeySize,
  planPolygonTasks,
  splitTask,
} from './soils-plan';
import { SDA_MAX_RESPONSE_BYTES, SDA_MAX_ROWS } from './soils-sda';

const LIMITS: BatchLimits = { maxBytes: 10_000, maxRows: 10, maxMukeys: 3, componentMukeys: 2 };
const size = (mukey: string, polygons: number, vertices = polygons * 10): MukeySize => ({
  mukey,
  polygons,
  vertices,
});

describe('limits', () => {
  test('defaults stay well under SDA documented limits', () => {
    expect(DEFAULT_LIMITS.maxBytes).toBeLessThanOrEqual(SDA_MAX_RESPONSE_BYTES / 2);
    expect(DEFAULT_LIMITS.maxRows).toBeLessThanOrEqual(SDA_MAX_ROWS / 2);
  });

  test('keys compare numerically', () => {
    expect(['10', '9', '100', '11'].sort(compareKeys)).toEqual(['9', '10', '11', '100']);
  });
});

describe('planPolygonTasks', () => {
  test('greedy batches in mukey order; empty map units skipped; every polygon planned once', () => {
    const sizes = [size('5', 4), size('3', 0), size('1', 3), size('2', 4), size('4', 2)];
    const tasks = planPolygonTasks(sizes, LIMITS);
    // 3 + 4 + 2 = 9 polygons fit the 10-row cap; '5' (4 more) starts a new batch.
    expect(tasks).toEqual([
      {
        kind: 'mukeys',
        mukeys: ['1', '2', '4'],
        polygons: 9,
        bytes:
          estimateBytes(size('1', 3)) + estimateBytes(size('2', 4)) + estimateBytes(size('4', 2)),
      },
      { kind: 'mukeys', mukeys: ['5'], polygons: 4, bytes: estimateBytes(size('5', 4)) },
    ]);
    const planned = tasks.flatMap((t) => (t.kind === 'mukeys' ? t.mukeys : [t.mukey]));
    expect(planned.sort()).toEqual(['1', '2', '4', '5']);
  });

  test('respects the map unit cap', () => {
    const tasks = planPolygonTasks(
      [size('1', 1), size('2', 1), size('3', 1), size('4', 1)],
      LIMITS,
    );
    expect(tasks.map((t) => (t.kind === 'mukeys' ? t.mukeys : []))).toEqual([
      ['1', '2', '3'],
      ['4'],
    ]);
  });

  test('a map unit over the limits on its own is paged, with a page that fits', () => {
    const tasks = planPolygonTasks([size('1', 2), size('2', 50, 5000), size('3', 2)], LIMITS);
    expect(tasks.map((t) => t.kind)).toEqual(['mukeys', 'paged', 'mukeys']);
    const paged = tasks[1];
    if (paged?.kind !== 'paged') throw new Error('expected paged');
    expect(paged.mukey).toBe('2');
    expect(paged.pageSize).toBeGreaterThanOrEqual(1);
    expect(paged.pageSize).toBeLessThanOrEqual(LIMITS.maxRows);
    const perPolygon = estimateBytes(size('2', 50, 5000)) / 50;
    expect(paged.pageSize * perPolygon).toBeLessThanOrEqual(LIMITS.maxBytes);
  });
});

describe('splitTask', () => {
  const sizes = new Map([size('1', 3), size('2', 4), size('3', 5)].map((s) => [s.mukey, s]));

  test('a batch splits in two halves with their own counts', () => {
    const parts = splitTask(
      { kind: 'mukeys', mukeys: ['1', '2', '3'], polygons: 12, bytes: 0 },
      sizes,
    );
    expect(parts?.map((p) => (p.kind === 'mukeys' ? [p.mukeys, p.polygons] : null))).toEqual([
      [['1', '2'], 7],
      [['3'], 5],
    ]);
  });

  test('one map unit becomes paged; a page halves; one polygon per page is the end', () => {
    const one = splitTask({ kind: 'mukeys', mukeys: ['3'], polygons: 5, bytes: 100 }, sizes);
    expect(one).toEqual([{ kind: 'paged', mukey: '3', polygons: 5, bytes: 100, pageSize: 3 }]);
    expect(
      splitTask({ kind: 'paged', mukey: '3', polygons: 5, bytes: 100, pageSize: 3 }, sizes),
    ).toEqual([{ kind: 'paged', mukey: '3', polygons: 5, bytes: 100, pageSize: 1 }]);
    expect(
      splitTask({ kind: 'paged', mukey: '3', polygons: 5, bytes: 100, pageSize: 1 }, sizes),
    ).toBeNull();
  });
});

describe('chunkKeys', () => {
  test('groups in numeric order', () => {
    expect(chunkKeys(['10', '2', '1', '3', '20'], 2)).toEqual([['1', '2'], ['3', '10'], ['20']]);
    expect(() => chunkKeys(['1'], 0)).toThrow();
  });
});
