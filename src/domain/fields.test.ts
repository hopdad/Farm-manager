import { describe, expect, test } from 'vitest';
import {
  boundaryEditPolicy,
  DEERE_BOUNDARY_READ_ONLY,
  FIELD_PANEL_SEASONS,
  FIELD_PARTS,
} from './fields';

describe('boundaryEditPolicy (D6: Deere is the boundary master)', () => {
  test('a Deere field is read-only, with the Ops Center message', () => {
    expect(boundaryEditPolicy({ deereFieldId: 'f-123' })).toEqual({
      editable: false,
      reason: DEERE_BOUNDARY_READ_ONLY,
    });
  });

  test('a field without a Deere id is editable', () => {
    expect(boundaryEditPolicy({ deereFieldId: null })).toEqual({ editable: true, reason: null });
  });
});

test('panel constants', () => {
  expect(FIELD_PANEL_SEASONS).toBe(5);
  expect(new Set(FIELD_PARTS).size).toBe(FIELD_PARTS.length);
});
