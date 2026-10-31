import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VEHICLE_KIND_TAGS,
  nextVehicleKind,
  parseVehicleKindTags,
  vehicleKindFromTags,
} from './vehicles';

describe('vehicle kind from vendor tags (1f.2)', () => {
  test('the first matching rule wins, case and spaces ignored; no match = null', () => {
    expect(vehicleKindFromTags(['Grain', ' PICKUP '])).toBe('pickup');
    expect(vehicleKindFromTags(['Service Truck', 'Semi'])).toBe('semi');
    expect(vehicleKindFromTags(['Grain'])).toBeNull();
    expect(vehicleKindFromTags([], DEFAULT_VEHICLE_KIND_TAGS)).toBeNull();
    const rules = parseVehicleKindTags('service_truck:Shop,pickup:Pickups');
    expect(vehicleKindFromTags(['shop'], rules)).toBe('service_truck');
  });

  test('parse: pairs of <kind>:<tag>; blank = the defaults; unknown kinds refused', () => {
    expect(parseVehicleKindTags('')).toEqual(DEFAULT_VEHICLE_KIND_TAGS);
    expect(parseVehicleKindTags(undefined)).toEqual(DEFAULT_VEHICLE_KIND_TAGS);
    expect(parseVehicleKindTags('pickup:Ford Fleet')).toEqual([
      { tag: 'ford fleet', kind: 'pickup' },
    ]);
    expect(() => parseVehicleKindTags('loader:Yard')).toThrow(/kind must be one of/);
    expect(() => parseVehicleKindTags('pickup')).toThrow(/kind must be one of/);
    expect(() => parseVehicleKindTags('pickup: ')).toThrow(/tag name is required/);
  });

  test('a kind set on /admin always wins; no tag kind changes nothing', () => {
    expect(nextVehicleKind({ kind: 'semi', kindSetBy: 'default' }, 'pickup')).toEqual({
      kind: 'pickup',
      kindSetBy: 'vendor',
    });
    expect(nextVehicleKind({ kind: 'pickup', kindSetBy: 'vendor' }, 'service_truck')).toEqual({
      kind: 'service_truck',
      kindSetBy: 'vendor',
    });
    expect(nextVehicleKind({ kind: 'service_truck', kindSetBy: 'admin' }, 'pickup')).toEqual({
      kind: 'service_truck',
      kindSetBy: 'admin',
    });
    expect(nextVehicleKind({ kind: 'semi', kindSetBy: 'default' }, null)).toEqual({
      kind: 'semi',
      kindSetBy: 'default',
    });
  });
});
