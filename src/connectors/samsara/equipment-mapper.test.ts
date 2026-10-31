import { describe, expect, test } from 'vitest';
import {
  engineHoursSource,
  equipmentPositionItems,
  equipmentStatItems,
  mapEquipmentPosition,
  mapEquipmentStat,
} from './equipment-mapper';

/** Built from Samsara's getEquipmentStatsFeed field examples (vendor-docs samsara.md §4). */
const SPEC_ROW = {
  id: '112',
  name: 'Crane A7',
  gps: [{ time: '2020-01-27T07:06:25Z', latitude: 41.9, longitude: -84.0, headingDegrees: 120 }],
  fuelPercents: [{ time: '2019-05-03T04:30:31Z', value: 54 }],
  obdEngineSeconds: [{ time: '2019-05-03T04:30:31Z', value: 22374000 }],
  gatewayJ1939EngineSeconds: [{ time: '2019-05-03T04:30:31Z', value: 22375800 }],
};

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('Samsara equipment feeds → live fixes and stats', () => {
  test('locations: one raw item per event; a live fix (position_vendor samsara)', () => {
    const r = equipmentPositionItems([
      {
        id: '112',
        name: 'SP2',
        locations: [
          {
            time: '2026-10-30T14:00:05Z',
            latitude: 41.9,
            longitude: -84.04,
            heading: 370,
            speed: 3.2,
          },
          { time: '2026-10-30T14:00:10Z', latitude: 41.91, longitude: -84.05 },
        ],
      },
      { id: 'bad', locations: [{ time: 'yesterday', latitude: 1, longitude: 2 }] },
    ]);
    expect(r.items.map((i) => i.externalId)).toEqual([
      '112:2026-10-30T14:00:05.000Z',
      '112:2026-10-30T14:00:10.000Z',
    ]);
    expect(r.dropped).toEqual([expect.objectContaining({ index: 1, id: 'bad' })]);
    expect(mapEquipmentPosition(roundTrip(r.items[0]?.payload))).toEqual([
      {
        source: 'samsara',
        externalMachineId: '112',
        sourceOrg: '',
        ts: '2026-10-30T14:00:05.000Z',
        lng: -84.04,
        lat: 41.9,
        heading: 10,
        speedMph: 3.2,
        engineOn: null,
        positionSource: 'eld',
      },
    ]);
    expect(mapEquipmentPosition(roundTrip(r.items[1]?.payload))[0]).toMatchObject({
      heading: null,
      speedMph: null,
    });
  });

  test("engine hours prefer obdEngineSeconds (the ECU's, not adjusted) over the gateway counts", () => {
    const { items } = equipmentStatItems('hours', [SPEC_ROW]);
    expect(items).toHaveLength(1);
    const [stat] = mapEquipmentStat(roundTrip(items[0]?.payload));
    expect(stat).toEqual({
      source: 'samsara',
      externalMachineId: '112',
      sourceOrg: '',
      ts: '2019-05-03T04:30:31.000Z',
      engineHours: 6215,
      fuelPct: 54,
      readings: {
        engineHours: {
          raw: 22374000,
          rawUnit: 'seconds',
          adjusted: false,
          field: 'obdEngineSeconds',
        },
        fuelPct: { raw: 54, rawUnit: 'percent', adjusted: null, field: 'fuelPercents' },
      },
    });
  });

  test('without the ECU count: the synthetic gateway hours, else the J1939 offset count (adjusted)', () => {
    const t = '2026-10-30T14:00:00Z';
    const synth = {
      id: 'g',
      gatewayEngineSeconds: [{ time: t, value: 3600 }],
      gatewayJ1939EngineSeconds: [{ time: t, value: 7200 }],
    };
    expect(engineHoursSource(synth)?.[0]).toBe('gatewayEngineSeconds');
    expect(mapEquipmentStat({ group: 'hours', row: synth })[0]?.readings?.engineHours).toEqual({
      raw: 3600,
      rawUnit: 'seconds',
      adjusted: true,
      field: 'gatewayEngineSeconds',
    });
    const j1939 = { id: 'g', gatewayJ1939EngineSeconds: [{ time: t, value: 7200 }] };
    expect(mapEquipmentStat({ group: 'hours', row: j1939 })[0]).toMatchObject({
      engineHours: 2,
      readings: { engineHours: { adjusted: true, field: 'gatewayJ1939EngineSeconds' } },
    });
    expect(engineHoursSource({ id: 'g' })).toBeNull();
  });

  test('engine state (obd preferred; Idle = running), GPS odometer (adjusted), one stat per time', () => {
    const row = {
      id: 'g',
      obdEngineStates: [
        { time: '2026-10-30T14:00:00Z', value: 'Idle' },
        { time: '2026-10-30T14:01:00Z', value: 'Off' },
        { time: '2026-10-30T14:02:00Z', value: 'Sleeping' },
      ],
      gatewayEngineStates: [{ time: '2026-10-30T14:00:00Z', value: 'Off' }],
      gpsOdometerMeters: [{ time: '2026-10-30T14:01:00Z', value: 16093.44 }],
    };
    const stats = mapEquipmentStat({ group: 'state', row });
    expect(stats.map((s) => [s.ts, s.engineOn, s.odometerMi])).toEqual([
      ['2026-10-30T14:00:00.000Z', true, undefined],
      ['2026-10-30T14:01:00.000Z', false, 10],
    ]);
    expect(stats[1]?.readings?.odometerMi).toEqual({
      raw: 16093.44,
      rawUnit: 'meters',
      adjusted: true,
      field: 'gpsOdometerMeters',
    });
    // Only the gateway's state when OBD sends none.
    const gw = mapEquipmentStat({
      group: 'state',
      row: { id: 'g', gatewayEngineStates: [{ time: '2026-10-30T14:00:00Z', value: 'On' }] },
    });
    expect(gw[0]?.readings?.engineOn?.field).toBe('gatewayEngineStates');
  });

  test("a row with none of the call's types lands nothing; a bad payload throws", () => {
    expect(equipmentStatItems('state', [SPEC_ROW]).items).toEqual([]);
    expect(() => mapEquipmentStat({ group: 'hours' })).toThrow();
  });
});
