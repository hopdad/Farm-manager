import { describe, expect, test } from 'vitest';
import { DEFAULT_SPRAY_THRESHOLDS } from '@/domain/weather';
import { parseSimWeatherForm, parseThresholdsForm, THRESHOLD_FIELDS } from './form';

const form = (values: Record<string, string>) => ({ get: (k: string) => values[k] ?? null });
const defaults = Object.fromEntries(
  Object.entries(DEFAULT_SPRAY_THRESHOLDS).map(([k, v]) => [k, String(v)]),
);

describe('/admin/spray forms', () => {
  test('every threshold has an input', () => {
    expect(THRESHOLD_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(DEFAULT_SPRAY_THRESHOLDS).sort(),
    );
  });

  test('the defaults round-trip; edits are numbers and verdicts', () => {
    expect(parseThresholdsForm(form(defaults))).toEqual({
      ok: true,
      thresholds: DEFAULT_SPRAY_THRESHOLDS,
    });
    const r = parseThresholdsForm(form({ ...defaults, windMaxMph: '12', rainVerdict: 'caution' }));
    expect(r).toEqual({
      ok: true,
      thresholds: { ...DEFAULT_SPRAY_THRESHOLDS, windMaxMph: 12, rainVerdict: 'caution' },
    });
  });

  test('bad values say which field', () => {
    expect(parseThresholdsForm(form({ ...defaults, gustMaxMph: '' }))).toEqual({
      ok: false,
      message: 'No-go above gusts: enter a number',
    });
    expect(parseThresholdsForm(form({ ...defaults, rainFreeHours: '2.5' }))).toMatchObject({
      ok: false,
    });
    expect(parseThresholdsForm(form({ ...defaults, inversionVerdict: 'maybe' }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Inversion risk means/),
    });
    // caution above the no-go line
    expect(parseThresholdsForm(form({ ...defaults, windCautionMph: '14' }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/windMinMph <= windCautionMph <= windMaxMph/),
    });
  });

  test('simulated weather: pin the wind, pick a pattern, or clear both', () => {
    expect(parseSimWeatherForm(form({ pinWind: 'true', windMph: '18', pattern: '' }))).toEqual({
      ok: true,
      request: { windMph: 18, pattern: null },
    });
    expect(
      parseSimWeatherForm(form({ pinWind: 'true', windMph: '4', pattern: 'dawn-inversion' })),
    ).toEqual({
      ok: true,
      request: { windMph: 4, pattern: 'dawn-inversion' },
    });
    expect(parseSimWeatherForm(form({ pattern: 'overnight-rain' }))).toEqual({
      ok: true,
      request: { windMph: null, pattern: 'overnight-rain' },
    });
    expect(parseSimWeatherForm(form({ clear: 'true' }))).toEqual({
      ok: true,
      request: { windMph: null, pattern: null },
    });
    expect(parseSimWeatherForm(form({ pinWind: 'true', windMph: '99' }))).toMatchObject({
      ok: false,
    });
    expect(parseSimWeatherForm(form({ pattern: 'hail' }))).toMatchObject({ ok: false });
  });
});
