import { describe, expect, test } from 'vitest';
import {
  fieldOperationsUrl,
  operationKindOf,
  operationMeasurementsSchema,
  operationProductSchema,
} from './operations';
import { pinViewSchema } from './pins';

describe('operations', () => {
  test("Deere's fieldOperationType maps case-insensitively; anything else is null", () => {
    expect(operationKindOf('Tillage')).toBe('tillage');
    expect(operationKindOf(' application ')).toBe('application');
    expect(operationKindOf('SEEDING')).toBe('seeding');
    expect(operationKindOf('harvest')).toBe('harvest');
    expect(operationKindOf('scouting')).toBeNull();
  });

  test('stored jsonb shapes validate', () => {
    expect(
      operationProductSchema.parse({
        name: 'P1185AM',
        kind: 'seed',
        rate: 34000,
        rateUnit: 'seeds1ac-1',
        total: null,
        totalUnit: null,
      }).name,
    ).toBe('P1185AM');
    expect(operationMeasurementsSchema.parse({})).toEqual({});
    expect(operationMeasurementsSchema.safeParse({ moisturePct: 140 }).success).toBe(false);
  });

  test('the field operations URL', () => {
    expect(fieldOperationsUrl('a b')).toBe('/api/fields/a%20b/operations');
    expect(fieldOperationsUrl('x', 2025)).toBe('/api/fields/x/operations?cropYear=2025');
  });
});

describe('pins', () => {
  test('a read-only Deere flag pin validates; other geometries do not', () => {
    const pin = {
      id: '0b7a3c8e-2f4d-5a1b-9c6e-7d8f9a0b1c2d',
      kind: 'rock',
      fieldId: null,
      fieldName: null,
      note: 'big rock',
      category: 'Rock',
      geometry: { type: 'Point', coordinates: [-84.05, 41.9] },
      source: 'deere_flag',
      readOnly: true,
      resolvedAt: null,
      createdAt: '2026-10-15T14:00:00Z',
      updatedAt: '2026-10-15T14:00:00Z',
    };
    expect(pinViewSchema.parse(pin).kind).toBe('rock');
    expect(
      pinViewSchema.safeParse({ ...pin, geometry: { type: 'MultiPoint', coordinates: [] } })
        .success,
    ).toBe(false);
  });
});
