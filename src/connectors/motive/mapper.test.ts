/**
 * Motive mapping on doc-shaped payloads (Motive's OpenAPI 3.1 examples): units and readings
 * (true_* adjusted, raw ones not), and every fault system Motive sends (OBD-II, SPN + FMI,
 * J1587 and OEM codes) in the one fault model with decision 1f-2's severity, states and times.
 */
import { describe, expect, test } from 'vitest';
import { normalizedFaultSchema } from '../../domain/fault-codes';
import { parseVehicleKindTags } from '../../domain/vehicles';
import {
  mapMotiveFault,
  mapMotivePosition,
  mapMotiveStat,
  mapMotiveVehicle,
  motiveInt,
} from './mapper';

const located_at = '2016-03-17T12:12:07Z';

describe('Motive positions', () => {
  test('v2: speed in mph; v3: kph converted and vehicle_state as the engine', () => {
    const v2 = mapMotivePosition({
      id: '23',
      number: 'V-1000',
      companyId: '285945',
      api: 'v2',
      location: { lat: 47.565647, lon: -122.276261, bearing: 90, speed: 65.1, located_at },
    })[0];
    expect(v2).toEqual({
      source: 'motive',
      externalMachineId: '23',
      sourceOrg: '285945',
      ts: '2016-03-17T12:12:07.000Z',
      lng: -122.276261,
      lat: 47.565647,
      heading: 90,
      speedMph: 65.1,
      engineOn: null,
      positionSource: 'eld',
    });
    const v3 = mapMotivePosition({
      id: '998707',
      companyId: '285945',
      api: 'v3',
      location: {
        lat: 27.4637528,
        lon: -82.5783576,
        bearing: null,
        located_at: '2024-05-24T16:34:49Z',
        kph: 100,
        vehicle_state: 'off',
      },
    })[0];
    expect(v3).toMatchObject({ speedMph: 62.1, heading: null, engineOn: false });
    // A 1a item (no company id) maps under ''.
    expect(
      mapMotivePosition({ id: '1', location: { lat: 1, lon: 2, located_at } })[0],
    ).toMatchObject({ sourceOrg: '', speedMph: null });
  });
});

describe('Motive stats', () => {
  test('true_* win as adjusted readings; the raw ones are used (not adjusted) when alone', () => {
    const [s] = mapMotiveStat({
      id: '23',
      companyId: '285945',
      location: {
        lat: 47.5,
        lon: -122.2,
        located_at,
        engine_hours: 123.56,
        true_engine_hours: 38.5,
        odometer: 456.22,
        true_odometer: 160.2742,
        fuel_primary_remaining_percentage: 50.5,
      },
    });
    expect(s).toEqual({
      source: 'motive',
      externalMachineId: '23',
      sourceOrg: '285945',
      ts: '2016-03-17T12:12:07.000Z',
      engineHours: 38.5,
      odometerMi: 160.2742,
      fuelPct: 50.5,
      readings: {
        engineHours: { raw: 38.5, rawUnit: 'hours', adjusted: true, field: 'true_engine_hours' },
        odometerMi: { raw: 160.2742, rawUnit: 'miles', adjusted: true, field: 'true_odometer' },
        fuelPct: {
          raw: 50.5,
          rawUnit: 'percent',
          adjusted: null,
          field: 'fuel_primary_remaining_percentage',
        },
      },
    });
    const [raw] = mapMotiveStat({
      id: '23',
      companyId: '',
      location: { lat: 1, lon: 2, located_at, engine_hours: 12, odometer: 34 },
    });
    expect(raw).toMatchObject({ engineHours: 12, odometerMi: 34 });
    expect(raw?.readings?.engineHours?.adjusted).toBe(false);
    expect(raw?.readings?.odometerMi).toMatchObject({ adjusted: false, field: 'odometer' });
    expect(raw).not.toHaveProperty('fuelPct'); // not sent: absent, never 0
  });

  test('nothing usable (none, negative, fuel over 100) → no item', () => {
    expect(
      mapMotiveStat({
        id: '1',
        companyId: '',
        location: {
          lat: 1,
          lon: 2,
          located_at,
          engine_hours: -1,
          fuel_primary_remaining_percentage: 140,
        },
      }),
    ).toEqual([]);
  });
});

const fault = (f: Record<string, unknown>) =>
  mapMotiveFault({
    companyId: '285945',
    fault: {
      id: 49487,
      status: 'open',
      first_observed_at: '2024-03-19T23:00:32Z',
      last_observed_at: '2024-03-19T23:59:32Z',
      vehicle: { id: 38640, number: 'Saad AssignVeh' },
      ...f,
    },
  });

describe('Motive faults (delta)', () => {
  test("OBD-II (Motive's own example): obd2, open, first/last observed, info without a MIL", () => {
    const [s] = fault({ code: 'U0046', code_label: 'U0046', network: 'obdii', fmi: null });
    expect(s).toMatchObject({
      source: 'motive',
      externalMachineId: '38640',
      sourceOrg: '285945',
      ts: '2024-03-19T23:59:32.000Z',
      faultReport: 'delta',
    });
    expect(s).not.toHaveProperty('faultAgeOutSeconds'); // Motive sends `closed`
    const f = s?.faultCodes?.[0];
    expect(normalizedFaultSchema.parse(f)).toMatchObject({
      system: 'obd2',
      dtc: 'U0046',
      code: 'U0046',
      severity: 'info',
      state: 'open',
      firstSeenAt: '2024-03-19T23:00:32.000Z',
      lastSeenAt: '2024-03-19T23:59:32.000Z',
      closedAt: null,
    });
  });

  test('closed: closedAt = last observed', () => {
    const [s] = fault({ code: 'P203F', code_label: 'P203F', network: 'obdii', status: 'closed' });
    expect(s?.faultCodes?.[0]).toMatchObject({
      state: 'closed',
      closedAt: '2024-03-19T23:59:32.000Z',
      description: null,
    });
  });

  test('SPN-<n> with an FMI → j1939 (the source address kept only in 0-255)', () => {
    const [a] = fault({
      code: '5610',
      code_label: 'SPN-5610',
      fmi: 5,
      fmi_description: 'Abnormal rate of change',
      network: 'j1587/j1708', // Motive's webhook example labels it so; the SPN decides
      source_address: '0',
      occurrence_count: 3,
    });
    expect(normalizedFaultSchema.parse(a?.faultCodes?.[0])).toMatchObject({
      system: 'j1939',
      spn: 5610,
      fmi: 5,
      sourceAddress: 0,
      occurrenceCount: 3,
      code: 'J1939 SPN 5610 FMI 5',
      severity: 'info', // Motive documents no lamp states
      description: 'Abnormal rate of change',
    });
    const [b] = fault({ code: '110', fmi: '0', network: 'j1939', source_address: '2024' });
    expect(b?.faultCodes?.[0]).toMatchObject({
      system: 'j1939',
      spn: 110,
      fmi: 0,
      sourceAddress: null,
    });
  });

  test('a J1587 PID and an OEM code → oem, verbatim; an OEM label sets the severity', () => {
    const [pid] = fault({ code: '110', code_label: 'PID-110', fmi: 0, network: 'j1587/j1708' });
    expect(normalizedFaultSchema.parse(pid?.faultCodes?.[0])).toMatchObject({
      system: 'oem',
      oemCode: 'PID-110 FMI 0',
      code: 'OEM PID-110 FMI 0',
      severity: 'warning',
    });
    const [oem] = fault({
      code: 'D1234',
      code_label: 'D1234',
      dtc_severity: 'High',
      network: null,
    });
    expect(normalizedFaultSchema.parse(oem?.faultCodes?.[0])).toMatchObject({
      system: 'oem',
      oemCode: 'D1234',
      vendorSeverity: 'High',
      severity: 'critical',
    });
  });

  test('a record with no vehicle or no time is skipped', () => {
    expect(fault({ code: 'P0217', vehicle: null })).toEqual([]);
    expect(fault({ code: 'P0217', first_observed_at: null, last_observed_at: null })).toEqual([]);
  });
});

describe('Motive vehicles', () => {
  test('group names → kind (VEHICLE_KIND_TAGS); year and VIN cleaned', () => {
    const rules = parseVehicleKindTags('semi:Hopper trucks');
    const [v] = mapMotiveVehicle(
      {
        companyId: '285945',
        vehicle: {
          id: '6620',
          number: '6620',
          make: 'Freightliner',
          model: 'Conv',
          year: '2006',
          vin: '',
        },
        groups: ['Hopper trucks'],
      },
      rules,
    );
    expect(v).toEqual({
      source: 'motive',
      sourceOrg: '285945',
      externalId: '6620',
      name: '6620',
      tags: ['Hopper trucks'],
      kindFromTags: 'semi',
      via: null,
      make: 'Freightliner',
      model: 'Conv',
      year: 2006,
      vin: null,
    });
  });

  test('motiveInt reads numbers and numeric strings', () => {
    expect([
      motiveInt('2024'),
      motiveInt(5),
      motiveInt(''),
      motiveInt('x'),
      motiveInt(null),
    ]).toEqual([2024, 5, null, null, null]);
  });
});
