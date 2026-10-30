import { describe, expect, test } from 'vitest';
import { formatVehicleStat, NOT_KNOWN, NOT_REPORTED } from './stats';

describe('formatVehicleStat (1f.2)', () => {
  test('known values in plain units', () => {
    expect(formatVehicleStat('engineHours', 4312.4)).toBe('4,312 h');
    expect(formatVehicleStat('odometerMi', 412_300)).toBe('412,300 mi');
    expect(formatVehicleStat('fuelPct', 61.6)).toBe('62 %');
    expect(formatVehicleStat('defPct', 140)).toBe('100 %');
    expect(formatVehicleStat('engineOn', true)).toBe('engine on');
    // A real zero is a value, not "not reported".
    expect(formatVehicleStat('fuelPct', 0, ['fuelPct'])).toBe('0 %');
  });

  test('no value: "not reported" when the route does not report it, else a dash', () => {
    expect(formatVehicleStat('engineHours', null, ['engineHours', 'odometerMi'])).toBe(
      NOT_REPORTED,
    );
    expect(formatVehicleStat('engineHours', undefined, [])).toBe(NOT_KNOWN);
    expect(formatVehicleStat('odometerMi', Number.NaN, ['odometerMi'])).toBe(NOT_REPORTED);
  });
});
