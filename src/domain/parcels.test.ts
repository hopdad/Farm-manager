import { describe, expect, test } from 'vitest';
import { COUNTY_FIPS, normalizeParcelNo, parcelId } from './parcels';

describe('parcel ids', () => {
  test('deterministic and insensitive to case and spacing', () => {
    const a = parcelId(COUNTY_FIPS.lenawee, 'xa0-123-4567-00');
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(parcelId('26091', '  XA0-123-4567-00 ')).toBe(a);
    expect(parcelId(COUNTY_FIPS.monroe, 'XA0-123-4567-00')).not.toBe(a);
  });

  test('refuses a bad county or an empty number', () => {
    expect(() => parcelId('2609', 'X')).toThrow();
    expect(() => parcelId('26091', '   ')).toThrow();
  });

  test('normalizeParcelNo', () => {
    expect(normalizeParcelNo(' ab  12 ')).toBe('AB 12');
  });
});
