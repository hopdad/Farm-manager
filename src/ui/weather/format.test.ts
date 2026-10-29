import { describe, expect, test } from 'vitest';
import { fmtAgeMinutes, fmtHour, fmtRain, fmtTemp, windFrom } from './format';

describe('weather formatting', () => {
  test('wind direction as the 16-point compass (blowing from)', () => {
    expect([0, 22, 45, 180, 225, 290, 350, 360].map(windFrom)).toEqual([
      'N',
      'NNE',
      'NE',
      'S',
      'SW',
      'WNW',
      'N',
      'N',
    ]);
    expect(windFrom(null)).toBe('');
  });

  test('temperatures, rain and ages', () => {
    expect(fmtTemp(51.6)).toBe('52°');
    expect(fmtTemp(null)).toBe('--');
    expect([0, 0.004, 0.123, null].map(fmtRain)).toEqual(['0"', '<0.01"', '0.12"', '--']);
    expect([0.4, 12, 125, 3000].map(fmtAgeMinutes)).toEqual([
      'just now',
      '12 min ago',
      '2 h ago',
      '2 d ago',
    ]);
  });

  test('hours in America/Detroit', () => {
    expect(fmtHour('2026-10-29T18:00:00.000Z')).toBe('2 PM');
    expect(fmtHour('2026-12-01T05:00:00.000Z')).toBe('12 AM');
  });
});
