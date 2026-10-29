import { describe, expect, test } from 'vitest';
import { type FieldSoilRow, summarizeFieldSoils } from './soils';

const row = (
  mukey: string,
  acres: number,
  pct: number,
  nccpi: number | null,
  drainage: string | null,
): FieldSoilRow => ({
  mukey,
  musym: null,
  muname: `unit ${mukey}`,
  dominantComponent: null,
  drainageClass: drainage,
  hydgrp: null,
  farmlandClass: null,
  nccpi,
  acres,
  pct,
});

describe('summarizeFieldSoils', () => {
  test('acre-weighted NCCPI, coverage, dominant unit and drainage mix', () => {
    const s = summarizeFieldSoils([
      row('a', 60, 37.5, 0.5, 'Poorly drained'),
      row('b', 90, 56.25, 0.8, 'Somewhat poorly drained'),
      row('c', 10, 6.25, null, null),
    ]);
    expect(s.weightedNccpi).toBe(0.68); // (60*0.5 + 90*0.8) / 150
    expect(s.coveredPct).toBe(100);
    expect(s.dominant?.mukey).toBe('b');
    expect(s.drainage).toEqual([
      { drainageClass: 'Somewhat poorly drained', acres: 90, pct: 56.3 },
      { drainageClass: 'Poorly drained', acres: 60, pct: 37.5 },
      { drainageClass: 'Unknown', acres: 10, pct: 6.3 },
    ]);
  });

  test('no rows or no NCCPI', () => {
    expect(summarizeFieldSoils([])).toEqual({
      weightedNccpi: null,
      coveredPct: 0,
      dominant: null,
      drainage: [],
    });
    expect(summarizeFieldSoils([row('a', 5, 100, null, null)]).weightedNccpi).toBeNull();
  });
});
