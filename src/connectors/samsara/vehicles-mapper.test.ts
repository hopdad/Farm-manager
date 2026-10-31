/**
 * Samsara vehicle list → NormalizedVehicle (pure): the kind from the tag names through
 * VEHICLE_KIND_TAGS, the via inferred from the record (no gateway + the carmaker's make, an asset
 * or vehicle gateway), the year as Samsara's string.
 */
import { describe, expect, test } from 'vitest';
import { parseVehicleKindTags } from '../../domain/vehicles';
import { mapSamsaraVehicle, samsaraVehicleVia } from './vehicles-mapper';
import type { SamsaraVehicle } from './vehicles-schemas';

const vehicle = (over: Partial<SamsaraVehicle> = {}): SamsaraVehicle => ({
  id: '281474977000001',
  name: 'PU1',
  make: 'Ford',
  model: 'F-250 Super Duty',
  year: '2023',
  tags: [{ id: '3914', name: 'Pickup' }],
  ...over,
});

describe('samsaraVehicleVia', () => {
  test('no Samsara gateway: Ford → Ford Pro, Ram / Dodge / Chrysler / Jeep → Stellantis', () => {
    expect(samsaraVehicleVia({ make: 'Ford' }, 'pickup')).toBe('ford_pro');
    for (const make of ['Ram', 'RAM', ' dodge ', 'Chrysler', 'Jeep']) {
      expect(samsaraVehicleVia({ make }, 'pickup'), make).toBe('stellantis');
    }
    expect(samsaraVehicleVia({ make: 'Chevrolet' }, 'pickup')).toBeNull();
    expect(samsaraVehicleVia({ make: null }, null)).toBeNull();
  });

  test('a gateway: AG* is an asset gateway; VG* on a pickup a plug-in OBD gateway; on a truck nothing to say', () => {
    expect(samsaraVehicleVia({ make: 'Ford', gateway: { model: 'AG26' } }, null)).toBe('gateway');
    expect(samsaraVehicleVia({ make: 'Ford', gateway: { model: 'VG54NA' } }, 'pickup')).toBe(
      'obd_device',
    );
    expect(
      samsaraVehicleVia({ make: 'Peterbilt', gateway: { model: 'VG54NA' } }, 'semi'),
    ).toBeNull();
    // A gateway object without a model says nothing either way.
    expect(samsaraVehicleVia({ make: 'Ford', gateway: { serial: 'X' } }, 'pickup')).toBeNull();
  });
});

describe('mapSamsaraVehicle', () => {
  test('a carmaker-cloud pickup: kind from its tag, via ford_pro, the year as a number', () => {
    expect(mapSamsaraVehicle({ vehicle: vehicle() })).toEqual([
      {
        source: 'samsara',
        sourceOrg: '',
        externalId: '281474977000001',
        name: 'PU1',
        tags: ['Pickup'],
        kindFromTags: 'pickup',
        via: 'ford_pro',
        make: 'Ford',
        model: 'F-250 Super Duty',
        year: 2023,
        vin: null,
      },
    ]);
  });

  test('a semi on a vehicle gateway; untagged and odd years', () => {
    const [semi] = mapSamsaraVehicle({
      vehicle: vehicle({
        name: 'S1',
        make: 'Peterbilt',
        tags: [{ id: '1', name: 'Semi' }],
        gateway: { model: 'VG54NA', serial: 'GVR1' },
      }),
    });
    expect(semi).toMatchObject({ kindFromTags: 'semi', via: null });
    const [bare] = mapSamsaraVehicle({ vehicle: { id: '7', year: 'n/a' } });
    expect(bare).toMatchObject({ name: '7', tags: [], kindFromTags: null, via: null, year: null });
  });

  test('the farm’s own tag names (VEHICLE_KIND_TAGS) decide; the first matching rule wins', () => {
    const rules = parseVehicleKindTags('service_truck:Service,pickup:Pickups');
    const [v] = mapSamsaraVehicle(
      {
        vehicle: vehicle({
          tags: [
            { id: '1', name: 'pickups' },
            { id: '2', name: 'Service' },
          ],
        }),
      },
      rules,
    );
    expect(v?.kindFromTags).toBe('service_truck');
    // A service truck (no gateway, a Ford) still comes through Ford Pro.
    expect(v?.via).toBe('ford_pro');
  });
});
