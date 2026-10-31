import { describe, expect, test } from 'vitest';
import { DELTA_FAULT_AGE_OUT_SECONDS, normalizedFaultSchema } from '../../domain/fault-codes';
import { CNH_XML } from '../aemp/fixtures/spec-examples';
import { aempBodyValue, parseFleetPage } from '../aemp/parse';
import {
  cnhBoundaryGeometry,
  cnhCautionFault,
  cnhMetricsPositions,
  mapCnhFault,
  mapCnhFleet,
  mapCnhPosition,
} from './mapper';
import { cnhBoundarySchema, cnhMetricsSchema } from './schemas';

const COMPANY = 'ACC000001111';

describe('CNH FieldOps mappers', () => {
  test('a Locations item is a LIVE fix of the VIN in its company (position_vendor cnh)', () => {
    expect(
      mapCnhPosition({
        vin: 'YJG1',
        companyId: COMPANY,
        location: { datetime: '2026-10-30T13:40:05Z', Latitude: 41.9, Longitude: -84.05 },
      }),
    ).toEqual([
      {
        source: 'cnh',
        externalMachineId: 'YJG1',
        sourceOrg: COMPANY,
        ts: '2026-10-30T13:40:05.000Z',
        lng: -84.05,
        lat: 41.9,
        heading: null,
        speedMph: null,
        engineOn: null,
        positionSource: 'eld',
      },
    ]);
  });

  test("the Fleet snapshot (CNH's spec example): stats and a LAST-KNOWN fix, source cnh", () => {
    const page = parseFleetPage(aempBodyValue(CNH_XML, 'application/xml', 'auto'), 'VIN');
    const m = page.machines[0];
    const items = mapCnhFleet(
      JSON.parse(
        JSON.stringify({
          vin: m?.id,
          companyId: COMPANY,
          snapshotTime: page.snapshotTime,
          equipment: m?.equipment,
        }),
      ),
    );
    const pos = items.find((i) => i.kind === 'position');
    expect(pos?.kind === 'position' && pos.position).toMatchObject({
      source: 'cnh',
      sourceOrg: COMPANY,
      externalMachineId: 'YJG23800100',
      positionKind: 'last_known',
      provider: null,
      engineOn: true,
      lat: 41.9012,
    });
    const stat = items.find((i) => i.kind === 'stat');
    expect(stat?.kind === 'stat' && stat.stat).toMatchObject({
      source: 'cnh',
      engineHours: 405.3,
      odometerMi: 40389.2, // 65000.1 km
      fuelPct: 56.3,
      defPct: 56.3,
      engineOn: true,
    });
  });

  test('caution codes: OEM caution, Active → open / false → closed; severity by the OEM rule', () => {
    const open = cnhCautionFault({
      datetime: '2026-10-30T10:00:00.000Z',
      Identifier: '1234',
      Description: 'Low hydraulic oil',
      Severity: 'Amber',
      Active: true,
    });
    expect(normalizedFaultSchema.parse(open)).toEqual({
      system: 'oem',
      oemCode: '1234',
      oemClass: 'caution',
      code: 'OEM caution 1234',
      severity: 'warning', // oemSeverity('Amber')
      description: 'Low hydraulic oil',
      vendorSeverity: 'Amber',
      state: 'open',
      firstSeenAt: '2026-10-30T10:00:00.000Z',
      lastSeenAt: '2026-10-30T10:00:00.000Z',
    });
    const closed = cnhCautionFault({
      datetime: '2026-10-30T11:00:00.000Z',
      Identifier: '1234',
      Active: false,
    });
    expect(closed).toMatchObject({
      state: 'closed',
      closedAt: '2026-10-30T11:00:00.000Z',
      severity: 'info',
    });
    expect(
      cnhCautionFault({ datetime: '2026-10-30T11:00:00.000Z', Identifier: '9', Severity: 'Purple' })
        .severity,
    ).toBe(
      'info', // unknown label: the caution class's default, the raw value kept
    );
    const [stat] = mapCnhFault({
      vin: 'YJG1',
      companyId: COMPANY,
      kind: 'caution',
      caution: { datetime: '2026-10-30T10:00:00Z', Identifier: '1234', Active: true },
    });
    expect(stat).toMatchObject({ source: 'cnh', faultReport: 'delta' });
    expect(stat?.faultAgeOutSeconds).toBeUndefined(); // CNH says when a caution clears
  });

  test('Faults occurrences: J1939 or OEM fault, open, aged out after a day', () => {
    const [j] = mapCnhFault({
      vin: 'YJG1',
      companyId: COMPANY,
      kind: 'fault',
      fault: {
        datetime: '2026-10-30T09:00:00Z',
        CodeIdentifier: 'SPN 100 FMI 1',
        CodeSeverity: 'Stop',
      },
    });
    expect(j).toMatchObject({
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
      faultCodes: [{ system: 'j1939', spn: 100, fmi: 1, state: 'open', vendorSeverity: 'Stop' }],
    });
    const [o] = mapCnhFault({
      vin: 'YJG1',
      companyId: COMPANY,
      kind: 'fault',
      fault: { datetime: '2026-10-30T09:00:00Z', CodeIdentifier: 'E-123' },
    });
    expect(o?.faultCodes?.[0]).toMatchObject({
      system: 'oem',
      oemClass: 'fault',
      code: 'OEM fault E-123',
    });
  });

  test('metrics: positions tagged POSITION_MISSING / GPS_TIMESTAMP_MISSING are dropped', () => {
    const page = cnhMetricsSchema.parse({
      links: [],
      items: [
        {
          systemDatetime: '2022-10-13T18:30:04Z',
          position: {
            time: '2022-10-13T18:30:04Z',
            latitude: 41.7,
            longitude: -81.7,
            errorTags: ['TIME_ZONE_NOT_ENRICHED'],
          },
        },
        {
          systemDatetime: '2022-10-13T18:31:04Z',
          position: {
            time: '2022-10-13T18:31:04Z',
            latitude: 41.8,
            longitude: -81.8,
            errorTags: 'POSITION_MISSING',
          },
        },
        {
          systemDatetime: '2022-10-13T18:32:04Z',
          position: {
            time: '2022-10-13T18:32:04Z',
            latitude: 41.9,
            longitude: -81.9,
            errorTags: ['GPS_TIMESTAMP_MISSING'],
          },
        },
        {
          systemDatetime: '2022-10-13T18:33:04Z',
          telemetry: [{ metric: 'GPS_ALT', value: '0.0' }],
        },
      ],
    });
    expect(cnhMetricsPositions('YJG1', COMPANY, page).map((p) => p.ts)).toEqual([
      '2022-10-13T18:30:04.000Z',
    ]);
  });

  test('a boundary record → MultiPolygon ([lon, lat]); a malformed one → null', () => {
    const ring = [
      [-84.05, 41.9],
      [-84.04, 41.9],
      [-84.04, 41.91],
      [-84.05, 41.9],
    ];
    const b = cnhBoundarySchema.parse({ boundaryId: 'b1', type: 'Polygon', coordinates: [ring] });
    expect(cnhBoundaryGeometry(b)).toEqual({ type: 'MultiPolygon', coordinates: [[ring]] });
    const bad = cnhBoundarySchema.parse({
      boundaryId: 'b2',
      type: 'Polygon',
      coordinates: [[[1, 2]]],
    });
    expect(cnhBoundaryGeometry(bad)).toBeNull();
  });
});
