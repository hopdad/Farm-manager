/**
 * MyGeotab mapping on api.json-shaped records: positions (LogRecord live, DeviceStatusInfo last
 * known), stats in the Diagnostic's unit with readings, and every fault system FaultData
 * carries (J1939 through the Diagnostic and FailureMode, OBD-II after the hex conversion,
 * proprietary as oem) with decision 1f-2's severity, states and times.
 */
import { describe, expect, test } from 'vitest';
import { normalizedFaultSchema } from '../../domain/fault-codes';
import { GEOTAB_SIM_DIAGNOSTICS } from '../../sim/vendors/geotab/catalog';
import {
  geotabSpeedMph,
  mapGeotabFault,
  mapGeotabPosition,
  mapGeotabStat,
  mapGeotabVehicle,
  obdDtc,
  obdPrefix,
} from './mapper';

const diag = (id: string) => GEOTAB_SIM_DIAGNOSTICS.find((d) => d.id === id) ?? null;
const at = '2026-10-30T15:04:05.000Z';

describe('Geotab positions', () => {
  test('LogRecord: a live fix, km/h → mph, no heading', () => {
    expect(
      mapGeotabPosition({
        entity: 'LogRecord',
        record: {
          id: 'b1A2',
          dateTime: at,
          device: { id: 'b0a46' },
          latitude: 42.2,
          longitude: -84.1,
          speed: 72,
        },
      }),
    ).toEqual([
      {
        source: 'geotab',
        externalMachineId: 'b0a46',
        sourceOrg: '',
        ts: at,
        lng: -84.1,
        lat: 42.2,
        heading: null,
        speedMph: 44.7,
        engineOn: null,
        positionSource: 'eld',
      },
    ]);
  });

  test('DeviceStatusInfo (limited scope): the last known position with its bearing', () => {
    const [p] = mapGeotabPosition({
      entity: 'DeviceStatusInfo',
      record: {
        device: 'b0a46',
        dateTime: at,
        latitude: 42.2,
        longitude: -84.1,
        bearing: 370,
        speed: -1,
      },
    });
    expect(p).toMatchObject({ positionKind: 'last_known', heading: 10, speedMph: null });
  });

  test('an invalid logged speed is unknown', () => {
    expect([
      geotabSpeedMph(-1),
      geotabSpeedMph(400),
      geotabSpeedMph(null),
      geotabSpeedMph(0),
    ]).toEqual([null, null, null, 0]);
  });
});

const stat = (diagnostic: string, data: number, d = diag(diagnostic)) =>
  mapGeotabStat({
    record: { dateTime: at, device: { id: 'b0a46' }, diagnostic: { id: diagnostic }, data },
    diagnostic: d,
  });

describe('Geotab stats (StatusData)', () => {
  test('engine hours in seconds (ECU: not adjusted), odometer in meters (adjusted)', () => {
    expect(stat('DiagnosticEngineHoursId', 7_200)[0]).toMatchObject({
      engineHours: 2,
      readings: {
        engineHours: {
          raw: 7_200,
          rawUnit: 'seconds',
          adjusted: false,
          field: 'DiagnosticEngineHoursId',
        },
      },
    });
    const [o] = stat('DiagnosticOdometerId', 1_609_344);
    expect(o?.odometerMi).toBeCloseTo(1000, 6);
    expect(o?.readings?.odometerMi).toMatchObject({ rawUnit: 'meters', adjusted: true });
  });

  test('fuel and DEF in percent, ignition as the engine state; nothing else set', () => {
    const [f] = stat('DiagnosticFuelLevelId', 62.6);
    expect(f).toEqual({
      source: 'geotab',
      externalMachineId: 'b0a46',
      sourceOrg: '',
      ts: at,
      fuelPct: 62.6,
      readings: {
        fuelPct: { raw: 62.6, rawUnit: 'percent', adjusted: null, field: 'DiagnosticFuelLevelId' },
      },
    });
    expect(stat('DiagnosticDieselExhaustFluidId', 71)[0]?.defPct).toBe(71);
    expect(stat('DiagnosticIgnitionId', 1)[0]?.engineOn).toBe(true);
    expect(stat('DiagnosticIgnitionId', 0)[0]?.engineOn).toBe(false);
  });

  test('a unit we cannot read, a DEF without a unit, or another diagnostic → nothing', () => {
    const km = { id: 'DiagnosticOdometerId', unitOfMeasure: { id: 'UnitOfMeasureKilometersId' } };
    expect(stat('DiagnosticOdometerId', 5, km)).toEqual([]);
    expect(stat('DiagnosticDieselExhaustFluidId', 70, null)).toEqual([]);
    expect(stat('DiagnosticEngineSpeedId', 1250)).toEqual([]);
    expect(stat('DiagnosticFuelLevelId', 140)).toEqual([]);
    // No Diagnostic at hand: the documented default unit (seconds, meters) is assumed.
    expect(stat('DiagnosticEngineHoursId', 3_600, null)[0]?.engineHours).toBe(1);
  });
});

const fault = (
  record: Record<string, unknown>,
  diagnostic: string | null,
  failureMode: { id: string; code?: number | null; name?: string } | null = null,
) =>
  mapGeotabFault({
    record: { id: 'aF1', dateTime: at, device: { id: 'b0a46' }, ...record },
    diagnostic: diagnostic ? diag(diagnostic) : null,
    failureMode,
  })[0];

describe('Geotab faults (FaultData, delta)', () => {
  test('J1939: SPN from the Diagnostic, FMI from the FailureMode, red stop lamp → critical', () => {
    const s = fault(
      {
        diagnostic: { id: 'aSimSpn110' },
        failureMode: { id: 'aSimFmi0' },
        faultState: 'Active',
        redStopLamp: true,
        amberWarningLamp: false,
        sourceAddress: 0,
        count: 3,
        severity: 'CheckImmediately',
      },
      'aSimSpn110',
      { id: 'aSimFmi0', code: 0, name: 'Above normal' },
    );
    expect(s).toMatchObject({
      source: 'geotab',
      externalMachineId: 'b0a46',
      ts: at,
      faultReport: 'delta',
    });
    expect(s).not.toHaveProperty('faultAgeOutSeconds');
    expect(normalizedFaultSchema.parse(s?.faultCodes?.[0])).toMatchObject({
      system: 'j1939',
      spn: 110,
      fmi: 0,
      sourceAddress: 0,
      occurrenceCount: 3,
      code: 'J1939 SPN 110 FMI 0',
      severity: 'critical',
      lamps: { redStop: true, amberWarning: false },
      vendorSeverity: 'CheckImmediately',
      description: 'Engine coolant temperature: Above normal',
      state: 'open',
      lastSeenAt: at,
      closedAt: null,
    });
  });

  test('J1939 without an FMI (NoFailureModeId) → an OEM code; lamp state alone sets lamps', () => {
    const s = fault({ faultState: 'Active', faultLampState: 'Warning' }, 'aSimSpn110', {
      id: 'NoFailureModeId',
      code: 0,
    });
    expect(normalizedFaultSchema.parse(s?.faultCodes?.[0])).toMatchObject({
      system: 'oem',
      oemCode: 'SPN 110',
      code: 'OEM fault SPN 110',
      lamps: { amberWarning: true },
    });
  });

  test('OBD-II: prefix from the controller, the code in hex (309 → P0135), MIL → warning', () => {
    const s = fault({ faultState: 'Active', malfunctionLamp: true }, 'aSimObd309', {
      id: 'NoFailureModeId',
    });
    expect(normalizedFaultSchema.parse(s?.faultCodes?.[0])).toMatchObject({
      system: 'obd2',
      dtc: 'P0135',
      code: 'P0135',
      severity: 'warning',
      lamps: { malfunction: true },
    });
    const pending = fault({ faultState: 'Pending' }, 'aSimObd309');
    expect(pending?.faultCodes?.[0]).toMatchObject({
      dtcState: 'pending',
      severity: 'info',
      state: 'open',
    });
  });

  test('Inactive / Cleared → closed at the record time', () => {
    for (const faultState of ['Inactive', 'Cleared']) {
      expect(fault({ faultState }, 'aSimObd309')?.faultCodes?.[0]).toMatchObject({
        state: 'closed',
        closedAt: at,
      });
    }
  });

  test('a proprietary code → oem, the severity label verbatim; an unknown diagnostic too', () => {
    const p = fault({ faultState: 'Active', severity: 'MaintenanceOnly' }, 'aSimProp4711');
    expect(normalizedFaultSchema.parse(p?.faultCodes?.[0])).toMatchObject({
      system: 'oem',
      oemCode: '4711',
      vendorSeverity: 'MaintenanceOnly',
      severity: 'warning',
      description: 'Aftertreatment derate',
    });
    const u = fault({ faultState: 'Active', diagnostic: { id: 'aUnknown' } }, null);
    expect(u?.faultCodes?.[0]).toMatchObject({ system: 'oem', oemCode: 'aUnknown' });
  });

  test('OBD helpers', () => {
    expect(obdPrefix('ControllerObdWwhPowertrainId')).toBe('P');
    expect(obdPrefix('ControllerObdBodyId')).toBe('B');
    expect(obdPrefix('ControllerObdChassisId')).toBe('C');
    expect(obdPrefix('ControllerObdNetworkingId')).toBe('U');
    expect(obdPrefix('ControllerJ1939EngineNo1Id')).toBeNull();
    expect(obdDtc('P', 309)).toBe('P0135');
    expect(obdDtc('U', 0x1a2)).toBe('U01A2');
    expect(obdDtc(null, 309)).toBeNull();
  });
});

describe('Geotab vehicles (Device)', () => {
  test('group names → kind; the VIN; no make/model/year in Geotab', () => {
    expect(
      mapGeotabVehicle({
        device: { id: 'b0a46', name: 'H2', vehicleIdentificationNumber: '4V4NC9EH5KN123456' },
        groups: ['Company Group', 'Semi'],
      }),
    ).toEqual([
      {
        source: 'geotab',
        sourceOrg: '',
        externalId: 'b0a46',
        name: 'H2',
        tags: ['Company Group', 'Semi'],
        kindFromTags: 'semi',
        via: null,
        make: null,
        model: null,
        year: null,
        vin: '4V4NC9EH5KN123456',
      },
    ]);
  });
});
