import { describe, expect, test } from 'vitest';
import { normalizeCrop as csvNormalizeCrop } from '../../tools/import/seasons-csv';
import { currentCropYear, normalizeCrop, normalizeDeereCrop } from './crops';

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
