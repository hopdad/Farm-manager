/**
 * Samsara faultCodes → the one fault model (slice 1f, docs/contracts-1f.md §5.3): every decision
 * 1f-2 case per system, the cleared reading, OBD-II per module (the scope the writer clears by),
 * OEM codes with Samsara's free-text severity, and the raw items one reading each.
 */
import { describe, expect, test } from 'vitest';
import { normalizedFaultSchema } from '../../domain/fault-codes';
import { mapSamsaraFaults, obdDtcFromId, samsaraFaultItems } from './mapper';
import { samsaraFaultCodesFeedSchema } from './schemas';

const TIME = '2020-10-27T14:11:00Z';
const ISO = '2020-10-27T14:11:00.000Z';

const one = (reading: Record<string, unknown>) => {
  const [stat] = mapSamsaraFaults({
    id: '494123',
    name: 'S3',
    reading: { time: TIME, ...reading },
  });
  if (!stat) throw new Error('no stat');
  for (const f of stat.faultCodes ?? [])
    expect(normalizedFaultSchema.safeParse(f).success).toBe(true);
  return stat;
};

const j1939 = (lights: Record<string, boolean> | undefined, codes = [{ spnId: 110, fmiId: 0 }]) =>
  one({
    canBusType: 'CANBUS_J1939_500',
    j1939: {
      ...(lights ? { checkEngineLights: lights } : {}),
      diagnosticTroubleCodes: codes.map((c) => ({
        txId: 0,
        milStatus: 0,
        occurrenceCount: 1,
        ...c,
      })),
    },
  });

const lamps = (over: Record<string, boolean>) => ({
  stopIsOn: false,
  warningIsOn: false,
  protectIsOn: false,
  emissionsIsOn: false,
  ...over,
});

describe('Samsara faultCodes mapping', () => {
  test('a reading is one snapshot report at its time, from the vehicle it names', () => {
    const s = j1939(lamps({}));
    expect(s).toMatchObject({
      source: 'samsara',
      externalMachineId: '494123',
      sourceOrg: '',
      ts: ISO,
      faultReport: 'snapshot',
      faultScope: { obdModules: [] },
    });
  });

  test('J1939 severity by the lamps of the reading (decision 1f-2)', () => {
    const sev = (l: Record<string, boolean> | undefined) => j1939(l).faultCodes?.[0]?.severity;
    expect(sev(lamps({ stopIsOn: true, warningIsOn: true }))).toBe('critical');
    expect(sev(lamps({ warningIsOn: true }))).toBe('warning');
    expect(sev(lamps({ protectIsOn: true }))).toBe('warning');
    expect(sev(lamps({ emissionsIsOn: true }))).toBe('warning');
    expect(sev(lamps({}))).toBe('info');
    expect(sev(undefined)).toBe('info'); // lamps not reported
  });

  test("Samsara's official J1939 example: identity, lamps, counts and description", () => {
    const s = one({
      j1939: {
        checkEngineLights: lamps({ protectIsOn: true, warningIsOn: true }),
        diagnosticTroubleCodes: [
          {
            fmiDescription: 'Voltage Below Normal',
            fmiId: 4,
            occurrenceCount: 25,
            spnId: 3510,
            spnDescription: 'Sensor supply voltage 2',
            milStatus: 1,
            txId: 1,
            sourceAddressName: 'Engine #2',
          },
        ],
      },
      canBusType: 'CANBUS_J1939_250',
    });
    expect(s.faultCodes).toEqual([
      {
        system: 'j1939',
        code: 'J1939 SPN 3510 FMI 4',
        severity: 'warning',
        spn: 3510,
        fmi: 4,
        sourceAddress: 1,
        occurrenceCount: 25,
        description: 'Sensor supply voltage 2: Voltage Below Normal (Engine #2)',
        lamps: { redStop: false, amberWarning: true, protect: true, malfunction: false },
        state: 'open',
        lastSeenAt: ISO,
      },
    ]);
  });

  test("the vendor's own DTC description wins; an out-of-range txId is no source address", () => {
    const s = j1939(lamps({}), [
      { spnId: 100, fmiId: 1, txId: 300, vendorSpecificFields: { dtcDescription: 'Low oil' } },
    ] as never);
    expect(s.faultCodes?.[0]).toMatchObject({ description: 'Low oil', sourceAddress: null });
  });

  test('no codes = cleared: an empty list (and a reading with no blocks at all)', () => {
    expect(j1939(lamps({}), []).faultCodes).toEqual([]);
    expect(one({ canBusType: 'CANBUS_J1939_500' }).faultCodes).toEqual([]);
  });

  test('the same SPN/FMI from two controllers is one fault with the larger count', () => {
    const s = j1939(lamps({ warningIsOn: true }), [
      { spnId: 168, fmiId: 4, txId: 0, occurrenceCount: 2 },
      { spnId: 168, fmiId: 4, txId: 3, occurrenceCount: 9 },
    ] as never);
    expect(s.faultCodes).toHaveLength(1);
    expect(s.faultCodes?.[0]).toMatchObject({ sourceAddress: 0, occurrenceCount: 9 });
  });

  test("OBD-II per module: Samsara's official example, states, MIL and the scope", () => {
    const s = one({
      obdii: {
        checkEngineLightIsOn: true,
        diagnosticTroubleCodes: [
          {
            confirmedDtcs: [
              {
                dtcDescription: 'Fuel Rail/System Pressure - Too Low Bank 1',
                dtcId: 135,
                dtcShortCode: 'P0087',
              },
            ],
            pendingDtcs: [],
            permanentDtcs: [],
            monitorStatus: {},
            txId: 2024,
            ignitionType: 'spark',
            milStatus: true,
          },
        ],
      },
      canBusType: 'CANBUS_PASSENGER_15765_11_500',
    });
    expect(s.faultScope).toEqual({ obdModules: ['2024'] });
    expect(s.faultCodes).toEqual([
      {
        system: 'obd2',
        code: 'P0087',
        severity: 'warning',
        dtc: 'P0087',
        dtcState: 'confirmed',
        lamps: { malfunction: true },
        description: 'Fuel Rail/System Pressure - Too Low Bank 1',
        state: 'open',
        lastSeenAt: ISO,
        module: '2024',
      },
    ]);
  });

  test('OBD-II severity: MIL or confirmed/permanent = warning, pending = info; never critical', () => {
    const s = one({
      obdii: {
        checkEngineLightIsOn: false,
        diagnosticTroubleCodes: [
          {
            txId: 2024,
            milStatus: false,
            confirmedDtcs: [{ dtcId: 0x0300 }],
            pendingDtcs: [{ dtcId: 0x0420, dtcShortCode: 'p0420' }],
            permanentDtcs: [
              { dtcId: 0x0171, dtcShortCode: 'P0171' },
              { dtcId: 0x0300, dtcShortCode: 'P0300' }, // also confirmed: one fault
            ],
          },
          { txId: 2025, pendingDtcs: [{ dtcId: 0xc100, dtcShortCode: 'U0100' }] },
        ],
      },
    });
    const by = new Map(s.faultCodes?.map((f) => [f.code, f]));
    expect([...by.keys()].sort()).toEqual(['P0171', 'P0300', 'P0420', 'U0100']);
    expect(by.get('P0300')).toMatchObject({ dtcState: 'confirmed', severity: 'warning' });
    expect(by.get('P0171')).toMatchObject({ dtcState: 'permanent', severity: 'warning' });
    expect(by.get('P0420')).toMatchObject({ dtcState: 'pending', severity: 'info' });
    // The reading's MIL stands in for a module that doesn't say (here: off).
    expect(by.get('U0100')).toMatchObject({ module: '2025', lamps: { malfunction: false } });
    expect(s.faultScope).toEqual({ obdModules: ['2024', '2025'] });
    // A pending code with the MIL on is a warning.
    const lit = one({
      obdii: {
        diagnosticTroubleCodes: [{ txId: 7, milStatus: true, pendingDtcs: [{ dtcId: 1 }] }],
      },
    });
    expect(lit.faultCodes?.[0]).toMatchObject({ code: 'P0001', severity: 'warning' });
  });

  test('a module with empty lists is in scope (its codes cleared); no obdii block = no scope', () => {
    const s = one({
      obdii: { diagnosticTroubleCodes: [{ txId: 2024, confirmedDtcs: [], pendingDtcs: [] }] },
    });
    expect(s.faultCodes).toEqual([]);
    expect(s.faultScope).toEqual({ obdModules: ['2024'] });
  });

  test('dtcId → DTC (SAE J2012) when dtcShortCode is missing', () => {
    expect(obdDtcFromId(135)).toBe('P0087');
    expect(obdDtcFromId(0x4123)).toBe('C0123');
    expect(obdDtcFromId(0x8abc)).toBe('B0ABC');
    expect(obdDtcFromId(0xd001)).toBe('U1001');
  });

  test("OEM codes: Samsara's example (free-text severity → the OEM default), known labels mapped", () => {
    const s = one({
      oem: {
        diagnosticTroubleCodes: [
          {
            codeIdentifier: 'CA2387',
            codeDescription: 'KVGT Servo Error',
            codeSeverity: 'L03',
            codeSource: 'ENG/M',
          },
          { codeIdentifier: 'X1', codeSeverity: 'High' },
          { codeIdentifier: 'X2', codeSeverity: 'low' },
          { codeDescription: 'no identifier: nothing to key it on' },
        ],
      },
    });
    expect(s.faultCodes).toEqual([
      {
        system: 'oem',
        code: 'OEM CA2387',
        severity: 'warning',
        oemCode: 'CA2387',
        vendorSeverity: 'L03',
        description: 'KVGT Servo Error (ENG/M)',
        state: 'open',
        lastSeenAt: ISO,
      },
      expect.objectContaining({ code: 'OEM X1', severity: 'critical', vendorSeverity: 'High' }),
      expect.objectContaining({ code: 'OEM X2', severity: 'info' }),
    ]);
  });

  test('a reading that cannot be read throws (the raw event counts an attempt)', () => {
    expect(() => mapSamsaraFaults({ id: 'x', reading: { time: 'yesterday' } })).toThrow();
    expect(() =>
      mapSamsaraFaults({
        id: 'x',
        reading: { time: TIME, j1939: { diagnosticTroubleCodes: [{ spnId: 600_000, fmiId: 0 }] } },
      }),
    ).toThrow();
  });

  test('feed page → one raw item per reading, keyed by vehicle and time', () => {
    const page = samsaraFaultCodesFeedSchema.parse({
      data: [
        {
          id: '112',
          name: 'S1',
          faultCodes: [
            { time: TIME, j1939: { diagnosticTroubleCodes: [] } },
            { time: '2020-10-27T14:12:00Z', j1939: { diagnosticTroubleCodes: [] }, extra: 1 },
          ],
        },
        { id: '113', name: 'S2' },
      ],
      pagination: { endCursor: 'c', hasNextPage: false },
    });
    const items = samsaraFaultItems(page);
    expect(items.map((i) => i.externalId)).toEqual([
      `112:faultCodes:${ISO}`,
      '112:faultCodes:2020-10-27T14:12:00.000Z',
    ]);
    // The whole reading travels (unknown keys included) into ingest.raw_events.
    expect(items[1]?.payload.reading).toMatchObject({ extra: 1 });
  });
});
