/**
 * Pure Samsara mappers: feed page → raw items (one event per item) and raw item → normalized
 * record. Raw payloads come back out of ingest.raw_events (jsonb), so each mapper re-validates
 * with the shared schema; a bad payload throws, which counts an attempt (contracts §8).
 *
 * Fault codes (slice 1f, docs/contracts-1f.md §5.3): one faultCodes reading → one `snapshot`
 * report in the one fault model (src/domain/fault-codes.ts), severity by decision 1f-2
 * (`faultSeverity`, through `normalizedFault`):
 *  - J1939: the reading's complete active set ("diagnosticTroubleCodes … empty if there are no
 *    active fault codes"); the reading's lamps (`checkEngineLights`) apply to every code in it;
 *    `txId` is the controller's source address.
 *  - OBD-II: listed per control module (`txId`), and Samsara doesn't say a reading carries every
 *    module. A module the reading names reports its complete set (its confirmed, pending and
 *    permanent lists); a module it doesn't name is "no change" for that module's codes. The
 *    report says which modules it covers (`faultScope.obdModules`) and each OBD-II fault its
 *    `module`, so the writer clears per module (src/db/queries/machine-faults.ts). The MIL is
 *    the module's `milStatus`, else the reading's `checkEngineLightIsOn`.
 *  - OEM: proprietary codes of OEM-integrated vehicles, part of the full snapshot like J1939;
 *    `codeSeverity` is kept verbatim as the vendor's severity (its values are undocumented, so
 *    `oemSeverity` usually doesn't know them and the OEM default applies: warning).
 */

import type {
  FaultModuleScope,
  ModuleFault,
  ScopedVehicleStat,
} from '../../db/queries/machine-faults';
import { type NormalizedFault, normalizedFault, type ObdDtcState } from '../../domain/fault-codes';
import { normalizeHeading } from '../../domain/fleet';
import type { NormalizedPosition, NormalizedVehicleStat, RawItem } from '../types';
import {
  SAMSARA_STAT_TYPES,
  type SamsaraFaultCodesFeed,
  type SamsaraFaultCodesReading,
  type SamsaraFaultRaw,
  type SamsaraLocationsFeed,
  type SamsaraPositionRaw,
  type SamsaraStatRaw,
  type SamsaraStatsFeed,
  samsaraFaultRawSchema,
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

// ---- fault codes -----------------------------------------------------------------------------

export function samsaraFaultItems(feed: SamsaraFaultCodesFeed): RawItem<SamsaraFaultRaw>[] {
  const items: RawItem<SamsaraFaultRaw>[] = [];
  for (const v of feed.data) {
    for (const reading of v.faultCodes ?? []) {
      items.push({
        externalId: `${v.id}:faultCodes:${isoOf(reading.time)}`,
        payload: {
          id: v.id,
          ...(v.name !== undefined ? { name: v.name } : {}),
          reading: reading as SamsaraFaultCodesReading,
        },
      });
    }
  }
  return items;
}

const OBD_LETTERS = ['P', 'C', 'B', 'U'] as const;

/**
 * An SAE J2012 DTC from its 16-bit number (Samsara's `dtcId`, used when `dtcShortCode` is
 * missing): letter from the top two bits, then a digit and three hex digits (135 → 'P0087').
 */
export function obdDtcFromId(id: number): string {
  const letter = OBD_LETTERS[(id >> 14) & 3] as string;
  const first = (id >> 12) & 3;
  const rest = (id & 0xfff).toString(16).toUpperCase().padStart(3, '0');
  return `${letter}${first}${rest}`;
}

/** OBD-II DTC states, the one kept first when a module lists a code in several lists. */
const OBD_LISTS: readonly [ObdDtcState, 'confirmedDtcs' | 'permanentDtcs' | 'pendingDtcs'][] = [
  ['confirmed', 'confirmedDtcs'],
  ['permanent', 'permanentDtcs'],
  ['pending', 'pendingDtcs'],
];

const text = (...parts: (string | null | undefined)[]): string | null => {
  const t = parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(': ');
  return t || null;
};

function j1939Faults(reading: SamsaraFaultCodesReading, ts: string): NormalizedFault[] {
  const j = reading.j1939;
  if (!j) return [];
  const l = j.checkEngineLights;
  const lamps = l
    ? {
        redStop: l.stopIsOn ?? null,
        amberWarning: l.warningIsOn ?? null,
        protect: l.protectIsOn ?? null,
        malfunction: l.emissionsIsOn ?? null,
      }
    : null;
  return (j.diagnosticTroubleCodes ?? []).map((d) => {
    const described =
      text(d.vendorSpecificFields?.dtcDescription) ?? text(d.spnDescription, d.fmiDescription);
    return normalizedFault({
      system: 'j1939',
      spn: d.spnId,
      fmi: d.fmiId,
      sourceAddress: d.txId !== undefined && d.txId >= 0 && d.txId <= 255 ? d.txId : null,
      occurrenceCount: d.occurrenceCount ?? null,
      description:
        described && d.sourceAddressName ? `${described} (${d.sourceAddressName})` : described,
      lamps,
      state: 'open',
      lastSeenAt: ts,
    });
  });
}

function obdFaults(reading: SamsaraFaultCodesReading, ts: string): ModuleFault[] {
  const o = reading.obdii;
  const out: ModuleFault[] = [];
  for (const m of o?.diagnosticTroubleCodes ?? []) {
    const mil = m.milStatus ?? o?.checkEngineLightIsOn ?? null;
    const seen = new Set<string>();
    for (const [state, list] of OBD_LISTS) {
      for (const d of m[list] ?? []) {
        const dtc = (d.dtcShortCode?.trim() || obdDtcFromId(d.dtcId)).toUpperCase();
        if (seen.has(dtc)) continue;
        seen.add(dtc);
        out.push({
          ...normalizedFault({
            system: 'obd2',
            dtc,
            dtcState: state,
            lamps: mil === null ? null : { malfunction: mil },
            description: text(d.dtcDescription),
            state: 'open',
            lastSeenAt: ts,
          }),
          module: String(m.txId),
        });
      }
    }
  }
  return out;
}

function oemFaults(reading: SamsaraFaultCodesReading, ts: string): NormalizedFault[] {
  const out: NormalizedFault[] = [];
  for (const d of reading.oem?.diagnosticTroubleCodes ?? []) {
    const code = d.codeIdentifier?.trim();
    if (!code) continue; // nothing to key it on
    out.push(
      normalizedFault({
        system: 'oem',
        oemCode: code,
        vendorSeverity: d.codeSeverity?.trim() || null,
        description: d.codeSource
          ? `${text(d.codeDescription) ?? code} (${d.codeSource.trim()})`
          : text(d.codeDescription),
        state: 'open',
        lastSeenAt: ts,
      }),
    );
  }
  return out;
}

/**
 * One faultCodes reading → one `snapshot` report (the active set at its time; [] = no codes),
 * with the OBD-II modules it covers. A code listed twice (two controllers sending the same
 * SPN/FMI) is one fault: the first wins, with the larger occurrence count.
 */
export function mapSamsaraFaults(raw: unknown): ScopedVehicleStat[] {
  const r = samsaraFaultRawSchema.parse(raw);
  const ts = isoOf(r.reading.time);
  const byCode = new Map<string, ModuleFault>();
  for (const f of [
    ...j1939Faults(r.reading, ts),
    ...obdFaults(r.reading, ts),
    ...oemFaults(r.reading, ts),
  ]) {
    const prev = byCode.get(f.code);
    if (!prev) byCode.set(f.code, f);
    else if ((f.occurrenceCount ?? 0) > (prev.occurrenceCount ?? 0)) {
      prev.occurrenceCount = f.occurrenceCount ?? null;
    }
  }
  const faultScope: FaultModuleScope = {
    obdModules: [
      ...new Set((r.reading.obdii?.diagnosticTroubleCodes ?? []).map((m) => String(m.txId))),
    ],
  };
  const stat: ScopedVehicleStat = {
    source: 'samsara',
    externalMachineId: r.id,
    sourceOrg: '',
    ts,
    faultCodes: [...byCode.values()],
    faultReport: 'snapshot',
    faultScope,
  };
  return [stat];
}
