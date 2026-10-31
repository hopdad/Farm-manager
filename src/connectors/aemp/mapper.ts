/**
 * Pure ISO 15143-3 mappers (docs/contracts-1f.md part B): a machine's snapshot sections →
 * a LAST-KNOWN position and stats, each dated by its own section's `datetime` (`Fleet@snapshotTime`
 * only for a section without one); a FaultCode occurrence → a `delta` fault with the age-out.
 * Raw payloads come back out of ingest.raw_events (jsonb), so every mapper re-validates; a bad
 * payload throws (an attempt is counted, contracts §8).
 *
 * Units are fixed by the standard (aemp.md §1.2): hours, kilometres (→ miles), percent 0-100.
 * Unit strings are compared case-insensitively; a Distance in an unknown unit is left out.
 */
import { z } from 'zod';
import {
  DELTA_FAULT_AGE_OUT_SECONDS,
  type NormalizedFault,
  normalizedFault,
  parseIsoJ1939,
} from '../../domain/fault-codes';
import {
  type NormalizedPosition,
  type NormalizedVehicleStat,
  normalizeStat,
  type StatRawUnit,
  type StatReading,
  type VehicleStatField,
} from '../types';
import {
  type AempDistance,
  type AempEquipment,
  type AempFaultCode,
  aempDateTime,
  aempEquipmentSchema,
  aempFaultCodeSchema,
} from './schemas';

/** One machine's new snapshot sections (what fleet.aemp lands in ingest.raw_events). */
export interface AempFleetRaw {
  /** The AEMP provider id (AEMP_PROVIDERS[].id): external_refs source_org, `aemp_<provider>`. */
  provider: string;
  /** The machine's id at the provider (`aempMachineId`): external_refs external_id. */
  machineId: string;
  /** The page's `Fleet@snapshotTime` (dates a section that carries no datetime of its own). */
  snapshotTime: string | null;
  /** EquipmentHeader plus the sections that moved since the last poll. */
  equipment: AempEquipment;
}

export const aempFleetRawSchema = z.object({
  provider: z.string().min(1),
  machineId: z.string().min(1),
  snapshotTime: aempDateTime.nullable(),
  equipment: aempEquipmentSchema,
});

/** One FaultCode occurrence of one machine (what the faults stream lands). */
export interface AempFaultRaw {
  provider: string;
  machineId: string;
  fault: AempFaultCode;
}

export const aempFaultRawSchema = z.object({
  provider: z.string().min(1),
  machineId: z.string().min(1),
  fault: aempFaultCodeSchema,
});

/** A fleet stream item: positions and stats come from one page set (one stream, one upsert). */
export type AempFleetItem =
  | { kind: 'position'; position: NormalizedPosition }
  | { kind: 'stat'; stat: NormalizedVehicleStat };

const round1 = (v: number) => Math.round(v * 10) / 10;

/** `kilometre` / `Kilometers` / `km` → the port's raw unit (null: unknown, left out). */
export function distanceUnit(units: string | undefined): StatRawUnit | null {
  const u = (units ?? 'kilometre')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (['kilometre', 'kilometres', 'kilometer', 'kilometers', 'km'].includes(u)) return 'kilometers';
  if (['mile', 'miles', 'mi'].includes(u)) return 'miles';
  if (['metre', 'metres', 'meter', 'meters', 'm'].includes(u)) return 'meters';
  return null;
}

function odometer(d: AempDistance): { mi: number; reading: StatReading } | null {
  const unit = distanceUnit(d.OdometerUnits);
  if (!unit) return null;
  return {
    mi: round1(normalizeStat(d.Odometer, unit)),
    reading: { raw: d.Odometer, rawUnit: unit, adjusted: null, field: 'Distance' },
  };
}

interface StatPart {
  field: VehicleStatField;
  value: number | boolean;
  reading: StatReading;
}

/** Whose snapshot it is: the generic AEMP client's (default) or CNH FieldOps' own ISO-style one. */
export interface SnapshotOwner {
  source: 'aemp' | 'cnh';
  /** external_refs source_org: the AEMP provider, or the CNH company id. */
  sourceOrg: string;
  /** NormalizedPosition.provider (`aemp_<provider>`), or null (CNH: position_vendor `cnh`). */
  provider: string | null;
}

/** The position (last-known) and stats of one machine's snapshot sections. */
export function aempSnapshotItems(raw: AempFleetRaw, owner?: SnapshotOwner): AempFleetItem[] {
  const { machineId, equipment: eq } = raw;
  const who: SnapshotOwner = owner ?? {
    source: 'aemp',
    sourceOrg: raw.provider,
    provider: raw.provider,
  };
  const at = (datetime: string | undefined) => datetime ?? raw.snapshotTime;
  const out: AempFleetItem[] = [];
  const base = { source: who.source, externalMachineId: machineId, sourceOrg: who.sourceOrg };

  const loc = eq.Location;
  const locTs = at(loc?.datetime);
  if (loc && locTs) {
    const engine = eq.EngineStatus;
    out.push({
      kind: 'position',
      position: {
        ...base,
        ts: locTs,
        lng: loc.Longitude,
        lat: loc.Latitude,
        heading: null,
        speedMph: null,
        // The engine state belongs to the position only when both were read at the same instant.
        engineOn: engine && at(engine.datetime) === locTs ? engine.Running : null,
        positionSource: 'eld',
        positionKind: 'last_known',
        provider: who.provider,
      },
    });
  }

  const parts = new Map<string, StatPart[]>();
  const add = (ts: string | null, part: StatPart) => {
    if (!ts) return;
    const list = parts.get(ts) ?? [];
    list.push(part);
    parts.set(ts, list);
  };
  const hours = eq.CumulativeOperatingHours;
  if (hours) {
    add(at(hours.datetime), {
      field: 'engineHours',
      value: round1(hours.Hour),
      // "generally the value of the hourmeter": the machine's own count, not adjusted.
      reading: {
        raw: hours.Hour,
        rawUnit: 'hours',
        adjusted: false,
        field: 'CumulativeOperatingHours',
      },
    });
  }
  if (eq.Distance) {
    const o = odometer(eq.Distance);
    if (o) add(at(eq.Distance.datetime), { field: 'odometerMi', value: o.mi, reading: o.reading });
  }
  if (eq.FuelRemaining) {
    const p = eq.FuelRemaining.Percent;
    add(at(eq.FuelRemaining.datetime), {
      field: 'fuelPct',
      value: p,
      reading: { raw: p, rawUnit: 'percent', adjusted: null, field: 'FuelRemaining' },
    });
  }
  if (eq.DEFRemaining) {
    const p = eq.DEFRemaining.Percent;
    add(at(eq.DEFRemaining.datetime), {
      field: 'defPct',
      value: p,
      reading: { raw: p, rawUnit: 'percent', adjusted: null, field: 'DEFRemaining' },
    });
  }
  if (eq.EngineStatus) {
    const on = eq.EngineStatus.Running;
    add(at(eq.EngineStatus.datetime), {
      field: 'engineOn',
      value: on,
      reading: { raw: on, rawUnit: 'boolean', adjusted: null, field: 'EngineStatus' },
    });
  }
  for (const [ts, list] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
    const stat: NormalizedVehicleStat = { ...base, ts, readings: {} };
    for (const p of list) {
      (stat as unknown as Record<string, unknown>)[p.field] = p.value;
      (stat.readings as Record<string, StatReading>)[p.field] = p.reading;
    }
    out.push({ kind: 'stat', stat });
  }
  return out;
}

/** The fleet stream's `map`: re-validate the landed payload, then `aempSnapshotItems`. */
export function mapAempFleet(raw: unknown): AempFleetItem[] {
  return aempSnapshotItems(aempFleetRawSchema.parse(raw));
}

/**
 * One ISO 15143-3 / CNH `FaultCode` occurrence as a fault: J1939 when `parseIsoJ1939` reads an SPN
 * and an FMI, else an OEM `fault` with the identifier verbatim; `open`, last (and first) seen at
 * its `datetime`; the severity by `faultSeverity` (decision 1f-2), the vendor's label kept.
 */
export function isoFault(f: {
  datetime: string;
  CodeIdentifier: string;
  CodeDescription?: string;
  CodeSeverity?: string;
}): NormalizedFault {
  const common = {
    description: f.CodeDescription || null,
    vendorSeverity: f.CodeSeverity || null,
    state: 'open' as const,
    firstSeenAt: f.datetime,
    lastSeenAt: f.datetime,
  };
  const j = parseIsoJ1939(f.CodeIdentifier);
  return j
    ? normalizedFault({ system: 'j1939', spn: j.spn, fmi: j.fmi, ...common })
    : normalizedFault({
        system: 'oem',
        oemCode: f.CodeIdentifier.trim(),
        oemClass: 'fault',
        ...common,
      });
}

/** The faults stream's `map`: one occurrence → a `delta` report that ages out (decision 1f-12). */
export function mapAempFault(raw: unknown): NormalizedVehicleStat[] {
  const r = aempFaultRawSchema.parse(raw);
  return [
    {
      source: 'aemp',
      externalMachineId: r.machineId,
      sourceOrg: r.provider,
      ts: r.fault.datetime,
      faultCodes: [isoFault(r.fault)],
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
    },
  ];
}
