/**
 * Pure Samsara mappers: feed page → raw items (one event per item) and raw item → normalized
 * record. Raw payloads come back out of ingest.raw_events (jsonb), so each mapper re-validates
 * with the shared schema; a bad payload throws, which counts an attempt (contracts §8).
 */
import { normalizeHeading } from '../../domain/fleet';
import type { NormalizedPosition, NormalizedVehicleStat, RawItem } from '../types';
import {
  SAMSARA_STAT_TYPES,
  type SamsaraLocationsFeed,
  type SamsaraPositionRaw,
  type SamsaraStatRaw,
  type SamsaraStatsFeed,
  samsaraPositionRawSchema,
  samsaraStatRawSchema,
} from './schemas';

const METERS_PER_MILE = 1609.344;

/** Canonical wall-clock ISO (Samsara may send `…Z` without millis). */
const isoOf = (t: string) => new Date(t).toISOString();

export function samsaraPositionItems(feed: SamsaraLocationsFeed): RawItem<SamsaraPositionRaw>[] {
  const items: RawItem<SamsaraPositionRaw>[] = [];
  for (const v of feed.data) {
    for (const location of v.locations) {
      items.push({
        externalId: `${v.id}:${isoOf(location.time)}`,
        payload: { id: v.id, ...(v.name !== undefined ? { name: v.name } : {}), location },
      });
    }
  }
  return items;
}

export function mapSamsaraPosition(raw: unknown): NormalizedPosition[] {
  const p = samsaraPositionRawSchema.parse(raw);
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

export function samsaraStatItems(feed: SamsaraStatsFeed): RawItem<SamsaraStatRaw>[] {
  const items: RawItem<SamsaraStatRaw>[] = [];
  for (const v of feed.data) {
    for (const type of SAMSARA_STAT_TYPES) {
      for (const stat of v[type] ?? []) {
        items.push({
          externalId: `${v.id}:${type}:${isoOf(stat.time)}`,
          payload: { id: v.id, ...(v.name !== undefined ? { name: v.name } : {}), type, stat },
        });
      }
    }
  }
  return items;
}

export function mapSamsaraStat(raw: unknown): NormalizedVehicleStat[] {
  const s = samsaraStatRaw(raw);
  const base = {
    source: 'samsara' as const,
    externalMachineId: s.id,
    sourceOrg: '',
    ts: isoOf(s.stat.time),
  };
  switch (s.type) {
    case 'obdEngineSeconds':
      return [{ ...base, engineHours: Math.round((s.stat.value / 3600) * 10) / 10 }];
    case 'obdOdometerMeters':
      return [{ ...base, odometerMi: Math.round((s.stat.value / METERS_PER_MILE) * 10) / 10 }];
    case 'fuelPercents':
      return [{ ...base, fuelPct: Math.min(100, Math.max(0, s.stat.value)) }];
  }
}

function samsaraStatRaw(raw: unknown): SamsaraStatRaw {
  return samsaraStatRawSchema.parse(raw);
}
