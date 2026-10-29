import { describe, expect, test } from 'vitest';
import { DEERE_BOUNDARY_READ_ONLY } from '../../domain/fields';
import type { FieldSoilRow } from '../../domain/soils';
import { makeFieldDetail } from '../../ui/fields/fixtures';
import { isUuid, toFieldDetail } from './fields';

/** The SQL's JSON: a FieldDetail without the parts computed in TS. */
function raw(overrides: Parameters<typeof makeFieldDetail>[0] = {}) {
  const { boundary, soilsSummary: _s, openJobs: _o, ...rest } = makeFieldDetail(overrides);
  return {
    ...rest,
    boundary: boundary && {
      id: boundary.id,
      acres: boundary.acres,
      source: boundary.source,
      sourceRef: boundary.sourceRef,
      validFrom: boundary.validFrom,
      bbox: boundary.bbox,
    },
  };
}

const soil = (mukey: string, acres: number, pct: number, nccpi: number | null): FieldSoilRow => ({
  mukey,
  musym: null,
  muname: mukey,
  dominantComponent: null,
  drainageClass: 'Well drained',
  hydgrp: null,
  farmlandClass: null,
  nccpi,
  acres,
  pct,
});

describe('toFieldDetail', () => {
  test('D6: a Deere field’s boundary is read-only, with the reason', () => {
    const d = toFieldDetail(raw());
    expect(d.boundary).toMatchObject({ editable: false, readOnlyReason: DEERE_BOUNDARY_READ_ONLY });
  });

  test('a field without a Deere id can be edited', () => {
    const d = toFieldDetail(raw({ field: { deereFieldId: null } }));
    expect(d.boundary).toMatchObject({ editable: true, readOnlyReason: null });
  });

  test('no boundary stays null; open jobs are the M2 placeholder', () => {
    const d = toFieldDetail(raw({ boundary: null }));
    expect(d.boundary).toBeNull();
    expect(d.openJobs).toEqual({ count: 0, placeholder: true });
  });

  test('the soils summary is computed when there are soils, else null', () => {
    expect(toFieldDetail(raw()).soilsSummary).toBeNull();
    const d = toFieldDetail(raw({ soils: [soil('a', 60, 75, 0.8), soil('b', 20, 25, 0.4)] }));
    expect(d.soilsSummary).toMatchObject({ weightedNccpi: 0.7, coveredPct: 100 });
    expect(d.soilsSummary?.dominant?.mukey).toBe('a');
  });
});

describe('isUuid', () => {
  test('accepts uuids in any case, refuses anything else', () => {
    expect(isUuid('489f2091-e897-52bc-b3ee-2605254c15c8')).toBe(true);
    expect(isUuid('489F2091-E897-52BC-B3EE-2605254C15C8')).toBe(true);
    expect(isUuid('489f2091e89752bcb3ee2605254c15c8')).toBe(false);
    expect(isUuid('489f2091-e897-52bc-b3ee-2605254c15c8 ')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
