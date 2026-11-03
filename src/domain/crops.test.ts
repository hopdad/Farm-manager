import { describe, expect, test } from 'vitest';
import { normalizeCrop as csvNormalizeCrop } from '../../tools/import/seasons-csv';
import {
  cropSeasonsToSync,
  currentCropYear,
  harvestCropYear,
  normalizeCrop,
  normalizeDeereCrop,
} from './crops';

describe('normalizeCrop', () => {
  test('common spellings become the app names; others are kept as typed', () => {
    expect(normalizeCrop(' Soybean ')).toBe('soybeans');
    expect(normalizeCrop('Field  Corn')).toBe('corn');
    expect(normalizeCrop('SRW')).toBe('wheat');
    expect(normalizeCrop('beans')).toBe('soybeans');
    expect(normalizeCrop(' Sugar beets ')).toBe('Sugar beets');
  });

  test('import:seasons uses the same function (re-exported)', () => {
    expect(csvNormalizeCrop).toBe(normalizeCrop);
  });
});

describe('normalizeDeereCrop', () => {
  test("Deere's crop tokens become the app names", () => {
    expect(normalizeDeereCrop('CORN_WET')).toBe('corn');
    expect(normalizeDeereCrop('CORN_DRY')).toBe('corn');
    expect(normalizeDeereCrop('SOYBEANS')).toBe('soybeans');
    expect(normalizeDeereCrop('WHEAT_SOFT_RED_WINTER')).toBe('wheat');
    expect(normalizeDeereCrop('corn_wet')).toBe('corn');
  });

  test('unknown tokens are written out in words; spellings go through normalizeCrop', () => {
    expect(normalizeDeereCrop('SUGAR_BEETS')).toBe('sugar beets');
    expect(normalizeDeereCrop('ALFALFA')).toBe('alfalfa');
    expect(normalizeDeereCrop('Winter wheat')).toBe('wheat');
    expect(normalizeDeereCrop('Popcorn (white)')).toBe('Popcorn (white)');
  });

  test('missing or blank is null', () => {
    expect(normalizeDeereCrop(undefined)).toBeNull();
    expect(normalizeDeereCrop(null)).toBeNull();
    expect(normalizeDeereCrop('  ')).toBeNull();
  });
});

describe('currentCropYear', () => {
  test('the calendar year in America/Detroit, not UTC', () => {
    expect(currentCropYear(new Date('2026-10-31T12:00:00Z'))).toBe(2026);
    // 03:30 UTC on Jan 1 is still Dec 31 in Michigan.
    expect(currentCropYear(new Date('2027-01-01T03:30:00Z'))).toBe(2026);
    expect(currentCropYear(new Date('2027-01-01T06:00:00Z'))).toBe(2027);
  });
});

describe('cropSeasonsToSync (D23: the growing year)', () => {
  test('Jul 31 23:59 EDT still asks last season and this one; Aug 1 00:00 EDT this one and next', () => {
    // EDT is UTC-4: Jul 31 23:59 in Adrian is 03:59 UTC on Aug 1.
    expect(cropSeasonsToSync(new Date('2027-08-01T03:59:00.000Z'))).toEqual([2026, 2027]);
    expect(cropSeasonsToSync(new Date('2027-08-01T03:59:59.999Z'))).toEqual([2026, 2027]);
    expect(cropSeasonsToSync(new Date('2027-08-01T04:00:00.000Z'))).toEqual([2027, 2028]);
    expect(harvestCropYear(new Date('2027-08-01T03:59:00.000Z'))).toBe(2026);
    expect(harvestCropYear(new Date('2027-08-01T04:00:00.000Z'))).toBe(2027);
  });

  test('the window does not move at New Year: Dec 31 23:59 EST and Jan 1 00:00 EST agree', () => {
    // EST is UTC-5: Dec 31 23:59 in Adrian is 04:59 UTC on Jan 1.
    const dec31 = new Date('2027-01-01T04:59:00.000Z');
    const jan1 = new Date('2027-01-01T05:00:00.000Z');
    expect(cropSeasonsToSync(dec31)).toEqual([2026, 2027]);
    expect(cropSeasonsToSync(jan1)).toEqual([2026, 2027]);
    expect(harvestCropYear(jan1)).toBe(2026);
    // The calendar year does turn there (a field with no operations falls back to it).
    expect(currentCropYear(dec31)).toBe(2026);
    expect(currentCropYear(jan1)).toBe(2027);
  });

  test('two seasons, oldest first, all year round', () => {
    for (let m = 0; m < 12; m++) {
      const at = new Date(Date.UTC(2027, m, 15, 17));
      const [a, b] = cropSeasonsToSync(at);
      expect(b).toBe(a + 1);
      expect(a).toBe(m < 7 ? 2026 : 2027);
    }
  });
});
