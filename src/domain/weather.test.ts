import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SPRAY_THRESHOLDS,
  defaultSprayThresholdsSetting,
  gridId,
  parseGridId,
  parseSprayThresholdsSetting,
  SPRAY_ASSESS_AHEAD_HOURS,
  SPRAY_REASON_CODES,
  SPRAY_VERDICTS,
  sprayAssessmentHours,
  sprayRulesVersion,
  sprayThresholdsSchema,
  sprayThresholdsSettingSchema,
  worstVerdict,
} from './weather';

describe('NWS grid ids', () => {
  test('round-trip and match the database CHECK format', () => {
    expect(gridId('DTX', 31, 40)).toBe('DTX/31,40');
    expect(parseGridId('DTX/31,40')).toEqual({ id: 'DTX/31,40', wfo: 'DTX', x: 31, y: 40 });
    expect(parseGridId('DTX-31-40')).toBeNull();
    expect(parseGridId('dtx/31,40')).toBeNull();
    expect(() => gridId('DTX', -1, 4)).toThrow();
  });
});

describe('verdicts', () => {
  test('worstVerdict', () => {
    expect(SPRAY_VERDICTS).toEqual(['go', 'caution', 'no_go']);
    expect(worstVerdict([])).toBe('go');
    expect(worstVerdict(['go', 'caution', 'go'])).toBe('caution');
    expect(worstVerdict(['caution', 'no_go', 'caution'])).toBe('no_go');
  });

  test('reason codes are unique', () => {
    expect(new Set(SPRAY_REASON_CODES).size).toBe(SPRAY_REASON_CODES.length);
  });
});

describe('spray thresholds (D4 defaults pending)', () => {
  test('the defaults validate and are frozen', () => {
    expect(sprayThresholdsSchema.parse(DEFAULT_SPRAY_THRESHOLDS)).toEqual(DEFAULT_SPRAY_THRESHOLDS);
    expect(Object.isFrozen(DEFAULT_SPRAY_THRESHOLDS)).toBe(true);
  });

  test('wind thresholds must be ordered; unknown keys are refused', () => {
    expect(
      sprayThresholdsSchema.safeParse({ ...DEFAULT_SPRAY_THRESHOLDS, windCautionMph: 12 }).success,
    ).toBe(false);
    expect(sprayThresholdsSchema.safeParse({ ...DEFAULT_SPRAY_THRESHOLDS, extra: 1 }).success).toBe(
      false,
    );
  });

  test('the stored setting: defaults flagged isDefault; anything invalid reads as the defaults', () => {
    const d = defaultSprayThresholdsSetting();
    expect(d.isDefault).toBe(true);
    expect(sprayThresholdsSettingSchema.parse(d)).toEqual(d);
    expect(parseSprayThresholdsSetting(undefined)).toEqual(d);
    expect(parseSprayThresholdsSetting({ thresholds: { windMaxMph: 'x' } })).toEqual(d);
    const custom = {
      thresholds: { ...DEFAULT_SPRAY_THRESHOLDS, windMaxMph: 12, windCautionMph: 9 },
      isDefault: false,
      updatedAt: '2026-12-01T14:00:00Z',
      updatedBy: 'Derrick',
    };
    expect(parseSprayThresholdsSetting(custom)).toEqual(custom);
    // A copy, so a caller can't change the shared defaults.
    d.thresholds.windMaxMph = 99;
    expect(DEFAULT_SPRAY_THRESHOLDS.windMaxMph).toBe(10);
  });

  test('rules version: stable for equal thresholds, different for different ones', () => {
    const a = sprayRulesVersion(DEFAULT_SPRAY_THRESHOLDS);
    expect(a).toMatch(/^v0-[0-9a-f]{8}$/);
    expect(sprayRulesVersion({ ...DEFAULT_SPRAY_THRESHOLDS })).toBe(a);
    expect(sprayRulesVersion({ ...DEFAULT_SPRAY_THRESHOLDS, gustMaxMph: 16 })).not.toBe(a);
    expect(sprayRulesVersion(DEFAULT_SPRAY_THRESHOLDS, 'v1')).toMatch(/^v1-/);
  });
});

describe('stored assessment window', () => {
  test('the current hour (floored, UTC) plus the next 12', () => {
    const hours = sprayAssessmentHours(new Date('2026-11-30T13:47:12.345Z'));
    expect(hours).toHaveLength(SPRAY_ASSESS_AHEAD_HOURS + 1);
    expect(hours[0]).toBe('2026-11-30T13:00:00.000Z');
    expect(hours[1]).toBe('2026-11-30T14:00:00.000Z');
    expect(hours.at(-1)).toBe('2026-12-01T01:00:00.000Z');
    // Whole hours only (the farm.spray_assessments CHECK), strictly increasing.
    for (const h of hours) expect(new Date(h).getTime() % 3_600_000).toBe(0);
    expect([...hours].sort()).toEqual(hours);
  });

  test('on the hour, across a DST change, and refusals', () => {
    expect(sprayAssessmentHours(new Date('2026-11-01T06:00:00Z'), 2)).toEqual([
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
    expect(sprayAssessmentHours(new Date('2026-11-01T06:00:00Z'), 0)).toHaveLength(1);
    expect(() => sprayAssessmentHours(new Date('nope'))).toThrow();
    expect(() => sprayAssessmentHours(new Date(), -1)).toThrow();
    expect(() => sprayAssessmentHours(new Date(), 1.5)).toThrow();
  });
});
