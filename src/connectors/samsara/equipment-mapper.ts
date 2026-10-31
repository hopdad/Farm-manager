/**
 * Pure Samsara equipment-feed mappers (docs/contracts-1f.md part B: the RoGator SP2 on an asset
 * gateway). Positions are LIVE fixes (position_vendor `samsara`); stats prefer the most direct
 * source Samsara sends for a machine:
 *  - engine hours: `obdEngineSeconds` (the ECU's count, `adjusted: false`) where sent, else
 *    `gatewayEngineSeconds` (synthetic, `adjusted: true`), else `gatewayJ1939EngineSeconds` (the
 *    J1939 count plus a manual offset, `adjusted: true`);
 *  - engine state: `obdEngineStates` (On/Idle = running) where sent, else `gatewayEngineStates`;
 *  - odometer: `gpsOdometerMeters` (GPS plus a manual offset, `adjusted: true`); fuel: fuelPercents.
 * A stat Samsara didn't send is absent, never 0. Payloads are re-validated (they come back out
 * of ingest.raw_events); a bad one throws (an attempt is counted).
 */
import { normalizeHeading } from '../../domain/fleet';
import {
  type NormalizedPosition,
  type NormalizedVehicleStat,
  normalizeStat,
  type RawItem,
  type StatReading,
  type VehicleStatField,
} from '../types';
import {
  EQUIPMENT_STAT_GROUPS,
  type EquipmentStatGroup,
  type SamsaraEquipmentPositionRaw,
  type SamsaraEquipmentStatRaw,
  type SamsaraEquipmentStatsRow,
  samsaraEquipmentLocationsRowSchema,
  samsaraEquipmentPositionRawSchema,
  samsaraEquipmentStatRawSchema,
  samsaraEquipmentStatsRowSchema,
} from './equipment-schemas';

/** Canonical wall-clock ISO (Samsara may send `…Z` without millis). */
const isoOf = (t: string) => new Date(t).toISOString();
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface EquipmentRowsResult<T> {
  items: RawItem<T>[];
  /** Rows that failed the schema (dropped, logged by the caller; never the page). */
  dropped: { index: number; id: string | null; reason: string }[];
}

const idOf = (row: unknown) => {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
};

const issueOf = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || '(row)'}: ${i.message}` : 'schema mismatch';
};

/** A locations feed page → one raw item per location event. */
export function equipmentPositionItems(
  data: unknown[],
): EquipmentRowsResult<SamsaraEquipmentPositionRaw> {
  const out: EquipmentRowsResult<SamsaraEquipmentPositionRaw> = { items: [], dropped: [] };
  data.forEach((row, index) => {
    const r = samsaraEquipmentLocationsRowSchema.safeParse(row);
    if (!r.success) {
      out.dropped.push({ index, id: idOf(row), reason: issueOf(r.error) });
      return;
    }
    for (const location of r.data.locations) {
      out.items.push({
        externalId: `${r.data.id}:${isoOf(location.time)}`,
        payload: {
          id: r.data.id,
          ...(r.data.name !== undefined ? { name: r.data.name } : {}),
          location,
        },
      });
    }
  });
  return out;
}

/** A stats feed page of one call → one raw item per machine (its events of that call). */
export function equipmentStatItems(
  group: EquipmentStatGroup,
  data: unknown[],
): EquipmentRowsResult<SamsaraEquipmentStatRaw> {
  const out: EquipmentRowsResult<SamsaraEquipmentStatRaw> = { items: [], dropped: [] };
  data.forEach((raw, index) => {
    const r = samsaraEquipmentStatsRowSchema.safeParse(raw);
    if (!r.success) {
      out.dropped.push({ index, id: idOf(raw), reason: issueOf(r.error) });
      return;
    }
    const row = r.data;
    const times = EQUIPMENT_STAT_GROUPS[group]
      .flatMap((t) => (row[t] ?? []).map((e) => isoOf(e.time)))
      .sort();
    if (!times.length) return;
    out.items.push({
      externalId: `${row.id}:${group}:${times[0]}..${times[times.length - 1]}`,
      payload: { group, row },
    });
  });
  return out;
}

export function mapEquipmentPosition(raw: unknown): NormalizedPosition[] {
  const p = samsaraEquipmentPositionRawSchema.parse(raw);
  const l = p.location;
  return [
    {
      source: 'samsara',
      externalMachineId: p.id,
      sourceOrg: '',
      ts: isoOf(l.time),
      lng: l.longitude,
      lat: l.latitude,
      heading: l.heading === undefined ? null : normalizeHeading(l.heading),
      speedMph: l.speed === undefined ? null : Math.max(0, l.speed),
      engineOn: null,
      positionSource: 'eld',
    },
  ];
}

type Part = { field: VehicleStatField; value: number | boolean; reading: StatReading };

const HOURS_PREFERENCE = [
  ['obdEngineSeconds', false],
  ['gatewayEngineSeconds', true],
  ['gatewayJ1939EngineSeconds', true],
] as const;

/** Which engine-hours stat a row's events come from (the most direct one sent), or null. */
export function engineHoursSource(
  row: SamsaraEquipmentStatsRow,
): (typeof HOURS_PREFERENCE)[number] | null {
  return HOURS_PREFERENCE.find(([t]) => (row[t] ?? []).length > 0) ?? null;
}

function stateOn(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === 'on' || v === 'idle') return true;
  if (v === 'off') return false;
  return null;
}

/** One machine's events of one call → stats, one per distinct event time. */
export function mapEquipmentStat(raw: unknown): NormalizedVehicleStat[] {
  const { row } = samsaraEquipmentStatRawSchema.parse(raw) as SamsaraEquipmentStatRaw;
  const parts = new Map<string, Part[]>();
  const add = (time: string, part: Part) => {
    const ts = isoOf(time);
    const list = parts.get(ts) ?? [];
    list.push(part);
    parts.set(ts, list);
  };
  const hours = engineHoursSource(row);
  if (hours) {
    const [type, adjusted] = hours;
    for (const e of row[type] ?? []) {
      add(e.time, {
        field: 'engineHours',
        value: round1(normalizeStat(e.value, 'seconds')),
        reading: { raw: e.value, rawUnit: 'seconds', adjusted, field: type },
      });
    }
  }
  for (const e of row.fuelPercents ?? []) {
    add(e.time, {
      field: 'fuelPct',
      value: Math.min(100, Math.max(0, e.value)),
      reading: { raw: e.value, rawUnit: 'percent', adjusted: null, field: 'fuelPercents' },
    });
  }
  for (const e of row.gpsOdometerMeters ?? []) {
    add(e.time, {
      field: 'odometerMi',
      value: round1(normalizeStat(e.value, 'meters')),
      reading: { raw: e.value, rawUnit: 'meters', adjusted: true, field: 'gpsOdometerMeters' },
    });
  }
  const stateType = (row.obdEngineStates ?? []).length ? 'obdEngineStates' : 'gatewayEngineStates';
  for (const e of row[stateType] ?? []) {
    const on = stateOn(e.value);
    if (on === null) continue;
    add(e.time, {
      field: 'engineOn',
      value: on,
      reading: { raw: on, rawUnit: 'boolean', adjusted: null, field: stateType },
    });
  }
  return [...parts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ts, list]) => {
      const stat: NormalizedVehicleStat = {
        source: 'samsara',
        externalMachineId: row.id,
        sourceOrg: '',
        ts,
        readings: {},
      };
      for (const p of list) {
        (stat as unknown as Record<string, unknown>)[p.field] = p.value;
        (stat.readings as Record<string, StatReading>)[p.field] = p.reading;
      }
      return stat;
    });
}
