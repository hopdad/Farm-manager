import { describe, expect, test } from 'vitest';
import { DELTA_FAULT_AGE_OUT_SECONDS, normalizedFaultSchema } from '../../domain/fault-codes';
import { DEERE_XML, ISO_XML, SAMSARA_JSON } from './fixtures/spec-examples';
import { distanceUnit, isoFault, mapAempFault, mapAempFleet } from './mapper';
import { aempBodyValue, parseFleetPage } from './parse';

const raw = (provider: string, body: unknown, idElement?: 'EquipmentID') => {
  const page = parseFleetPage(body, idElement);
  const m = page.machines[0];
  if (!m) throw new Error('no machine');
  // Through JSON, as the payload comes back out of ingest.raw_events.
  return JSON.parse(
    JSON.stringify({
      provider,
      machineId: m.id,
      snapshotTime: page.snapshotTime,
      equipment: m.equipment,
    }),
  );
};

describe('AEMP snapshot → last-known position and stats', () => {
  test('a last-known position (provider set) and stats grouped by their own datetime', () => {
    const items = mapAempFleet(raw('kubota', aempBodyValue(ISO_XML, 'application/xml', 'auto')));
    expect(items[0]).toEqual({
      kind: 'position',
      position: {
        source: 'aemp',
        externalMachineId: 'KBCZ097C0L1R42001',
        sourceOrg: 'kubota',
        ts: '2026-10-30T14:00:00.000Z',
        lng: -84.0412345,
        lat: 41.912345,
        heading: null,
        speedMph: null,
        engineOn: false, // EngineStatus read at the Location's instant
        positionSource: 'eld',
        positionKind: 'last_known',
        provider: 'kubota',
      },
    });
    const stats = items.filter((i) => i.kind === 'stat').map((i) => i.stat);
    expect(stats.map((s) => s.ts)).toEqual([
      '2026-10-30T13:45:00.000Z',
      '2026-10-30T14:00:00.000Z',
    ]);
    expect(stats[0]).toMatchObject({
      engineHours: 1912.4,
      fuelPct: 62.5,
      defPct: 71,
      readings: {
        engineHours: {
          raw: 1912.4,
          rawUnit: 'hours',
          adjusted: false,
          field: 'CumulativeOperatingHours',
        },
        fuelPct: { raw: 62.5, rawUnit: 'percent', adjusted: null, field: 'FuelRemaining' },
        defPct: { raw: 71, rawUnit: 'percent', adjusted: null, field: 'DEFRemaining' },
      },
    });
    expect(stats[0]).not.toHaveProperty('odometerMi'); // not sent: absent, never 0
    expect(stats[1]).toEqual({
      source: 'aemp',
      externalMachineId: 'KBCZ097C0L1R42001',
      sourceOrg: 'kubota',
      ts: '2026-10-30T14:00:00.000Z',
      engineOn: false,
      readings: {
        engineOn: { raw: false, rawUnit: 'boolean', adjusted: null, field: 'EngineStatus' },
      },
    });
  });

  test('Samsara: kilometres → miles, engine state, EquipmentID', () => {
    const items = mapAempFleet(raw('samsara', SAMSARA_JSON, 'EquipmentID'));
    const stat = items.find((i) => i.kind === 'stat');
    expect(stat?.kind === 'stat' && stat.stat).toMatchObject({
      externalMachineId: '494123',
      sourceOrg: 'samsara',
      engineHours: 12.3,
      odometerMi: 7.5, // 12 km
      fuelPct: 12,
      defPct: 12,
      engineOn: true,
      readings: { odometerMi: { raw: 12, rawUnit: 'kilometers', field: 'Distance' } },
    });
    const pos = items.find((i) => i.kind === 'position');
    expect(pos?.kind === 'position' && pos.position.engineOn).toBe(true);
  });

  test("sections without a datetime (Deere's example) are dated by the page's snapshotTime", () => {
    const items = mapAempFleet(raw('deere', aempBodyValue(DEERE_XML, 'application/xml', 'auto')));
    expect(items.map((i) => (i.kind === 'position' ? i.position.ts : i.stat.ts))).toEqual([
      '2017-03-24T13:02:38.191Z',
      '2017-03-24T13:02:38.191Z',
    ]);
    const stat = items[1];
    expect(stat?.kind === 'stat' && stat.stat).toMatchObject({
      engineHours: 428.7,
      odometerMi: 11726.4,
      fuelPct: 48.8,
      defPct: 34.4,
    });
  });

  test('a section with no datetime and no snapshotTime is left out; an unknown unit too', () => {
    const items = mapAempFleet({
      provider: 'x',
      machineId: 'M',
      snapshotTime: null,
      equipment: {
        EquipmentHeader: { PIN: 'M' },
        CumulativeOperatingHours: { Hour: 5 },
        Distance: { Odometer: 9, OdometerUnits: 'furlongs', datetime: '2026-10-30T10:00:00Z' },
      },
    });
    expect(items).toEqual([]);
    expect(distanceUnit('Kilometers')).toBe('kilometers');
    expect(distanceUnit(undefined)).toBe('kilometers'); // ISO fixes kilometre
    expect(distanceUnit('mi')).toBe('miles');
    expect(distanceUnit('furlongs')).toBeNull();
  });

  test('a bad payload throws (an attempt is counted)', () => {
    expect(() => mapAempFleet({ provider: 'x' })).toThrow();
  });
});

describe('AEMP fault occurrences → delta faults with the age-out', () => {
  test('a J1939 identifier becomes j1939; anything else an OEM fault; severity by the policy', () => {
    const j = isoFault({
      datetime: '2026-10-30T09:12:00.000Z',
      CodeIdentifier: 'SPN 110 FMI 0',
      CodeDescription: 'Engine coolant temperature high',
      CodeSeverity: 'High',
    });
    expect(normalizedFaultSchema.parse(j)).toEqual({
      system: 'j1939',
      spn: 110,
      fmi: 0,
      code: 'J1939 SPN 110 FMI 0',
      severity: 'info', // decision 1f-2: j1939 without lamps; the vendor's label is kept
      description: 'Engine coolant temperature high',
      vendorSeverity: 'High',
      state: 'open',
      firstSeenAt: '2026-10-30T09:12:00.000Z',
      lastSeenAt: '2026-10-30T09:12:00.000Z',
    });
    const oem = isoFault({
      datetime: '2026-10-30T10:30:00.000Z',
      CodeIdentifier: 'E9031',
      CodeSeverity: 'Low',
    });
    expect(normalizedFaultSchema.parse(oem)).toMatchObject({
      system: 'oem',
      oemCode: 'E9031',
      oemClass: 'fault',
      code: 'OEM fault E9031',
      severity: 'info', // oemSeverity('Low')
    });
    expect(isoFault({ datetime: '2026-10-30T10:30:00.000Z', CodeIdentifier: 'X1' }).severity).toBe(
      'warning', // an unknown label: the OEM rule's default for a fault
    );
  });

  test('mapAempFault: one occurrence, delta, aged out after DELTA_FAULT_AGE_OUT_SECONDS', () => {
    const [s] = mapAempFault({
      provider: 'kubota',
      machineId: 'KUB1',
      fault: { datetime: '2026-10-30T09:12:00Z', CodeIdentifier: '110-0' },
    });
    expect(s).toMatchObject({
      source: 'aemp',
      externalMachineId: 'KUB1',
      sourceOrg: 'kubota',
      ts: '2026-10-30T09:12:00.000Z',
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
      faultCodes: [{ system: 'j1939', spn: 110, fmi: 0, state: 'open' }],
    });
  });
});
