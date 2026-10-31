/**
 * Pure CNH FieldOps mappers (docs/contracts-1f.md part B): machines are addressed by VIN, in a
 * company (`companyId`: the external_refs source_org); position_vendor `cnh`.
 *  - `Locations` series items → LIVE fixes (the trail since the last fix);
 *  - the `Fleet/{page}` snapshot → stats (hours, distance, fuel %, DEF %, engine status) and its
 *    `Location` as a LAST-KNOWN fix (it may lag "up to one hour"), through the ISO mapper;
 *  - `CautionCodes` items → OEM caution codes, `Active` true/false → open/closed (`delta`);
 *  - `Faults` items → occurrences with no state: J1939 when the identifier parses, else an OEM
 *    fault; open, aged out after DELTA_FAULT_AGE_OUT_SECONDS (decision 1f-12);
 *  - `/equipment/{vin}/metrics` positions, dropping those tagged POSITION_MISSING or
 *    GPS_TIMESTAMP_MISSING (CNH's error-tag table).
 * CNH severity strings aren't enumerated: `faultSeverity` decides (unknown → the OEM rule's
 * default), the raw value kept as `vendorSeverity`.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { z } from 'zod';
import {
  DELTA_FAULT_AGE_OUT_SECONDS,
  type NormalizedFault,
  normalizedFault,
} from '../../domain/fault-codes';
import { type AempFleetItem, aempSnapshotItems, isoFault } from '../aemp/mapper';
import {
  type AempCaution,
  aempCautionSchema,
  aempDateTime,
  aempEquipmentSchema,
  aempFaultCodeSchema,
  aempLocationItemSchema,
} from '../aemp/schemas';
import type { NormalizedPosition, NormalizedVehicleStat } from '../types';
import type { CnhBoundary, CnhMetrics } from './schemas';

const vinOrg = { vin: z.string().min(1), companyId: z.string().min(1) };

/** One Locations item of one VIN (cnh / positions). */
export const cnhPositionRawSchema = z.object({ ...vinOrg, location: aempLocationItemSchema });
export type CnhPositionRaw = z.infer<typeof cnhPositionRawSchema>;

/** One machine's moved snapshot sections (cnh / fleet). */
export const cnhFleetRawSchema = z.object({
  ...vinOrg,
  snapshotTime: aempDateTime.nullable(),
  equipment: aempEquipmentSchema,
});
export type CnhFleetRaw = z.infer<typeof cnhFleetRawSchema>;

/** One caution code or fault occurrence of one VIN (cnh / faults). */
export const cnhFaultRawSchema = z.discriminatedUnion('kind', [
  z.object({ ...vinOrg, kind: z.literal('caution'), caution: aempCautionSchema }),
  z.object({ ...vinOrg, kind: z.literal('fault'), fault: aempFaultCodeSchema }),
]);
export type CnhFaultRaw = z.infer<typeof cnhFaultRawSchema>;

export function mapCnhPosition(raw: unknown): NormalizedPosition[] {
  const r = cnhPositionRawSchema.parse(raw);
  return [
    {
      source: 'cnh',
      externalMachineId: r.vin,
      sourceOrg: r.companyId,
      ts: r.location.datetime,
      lng: r.location.Longitude,
      lat: r.location.Latitude,
      heading: null,
      speedMph: null,
      engineOn: null,
      positionSource: 'eld',
    },
  ];
}

/** The snapshot's stats and last-known Location (the ISO mapper with CNH as the owner). */
export function mapCnhFleet(raw: unknown): AempFleetItem[] {
  const r = cnhFleetRawSchema.parse(raw);
  return aempSnapshotItems(
    { provider: 'cnh', machineId: r.vin, snapshotTime: r.snapshotTime, equipment: r.equipment },
    { source: 'cnh', sourceOrg: r.companyId, provider: null },
  );
}

/** A caution code: OEM, class `caution`, open while `Active` (closed when it says false). */
export function cnhCautionFault(c: AempCaution): NormalizedFault {
  const closed = c.Active === false;
  return normalizedFault({
    system: 'oem',
    oemCode: c.Identifier.trim(),
    oemClass: 'caution',
    description: c.Description || null,
    vendorSeverity: c.Severity || null,
    state: closed ? 'closed' : 'open',
    lastSeenAt: c.datetime,
    ...(closed ? { closedAt: c.datetime } : { firstSeenAt: c.datetime }),
  });
}

export function mapCnhFault(raw: unknown): NormalizedVehicleStat[] {
  const r = cnhFaultRawSchema.parse(raw);
  const base = { source: 'cnh' as const, externalMachineId: r.vin, sourceOrg: r.companyId };
  if (r.kind === 'caution') {
    return [
      {
        ...base,
        ts: r.caution.datetime,
        faultCodes: [cnhCautionFault(r.caution)],
        faultReport: 'delta',
      },
    ];
  }
  return [
    {
      ...base,
      ts: r.fault.datetime,
      faultCodes: [isoFault(r.fault)],
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
    },
  ];
}

/** Error tags that make a metrics position unusable (CNH's errorTags table). */
export const CNH_BAD_POSITION_TAGS = ['POSITION_MISSING', 'GPS_TIMESTAMP_MISSING'] as const;

/** The usable positions of a metrics page (live fixes), tagged ones dropped. */
export function cnhMetricsPositions(
  vin: string,
  companyId: string,
  page: CnhMetrics,
): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];
  for (const item of page.items) {
    const p = item.position;
    if (!p || p.latitude == null || p.longitude == null || !p.time) continue;
    if (p.errorTags.some((t) => (CNH_BAD_POSITION_TAGS as readonly string[]).includes(t))) continue;
    const t = Date.parse(p.time);
    if (Number.isNaN(t) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) continue;
    out.push({
      source: 'cnh',
      externalMachineId: vin,
      sourceOrg: companyId,
      ts: new Date(t).toISOString(),
      lng: p.longitude,
      lat: p.latitude,
      heading: null,
      speedMph: null,
      engineOn: null,
      positionSource: 'eld',
    });
  }
  return out;
}

/**
 * One CNH boundary record's geometry as a MultiPolygon (GeoJSON-shaped, [lon, lat]). A field is
 * made of OUTER and INNER records; combining them needs a field-matching rule (M2), so 1f.2 only
 * reads them.
 */
export function cnhBoundaryGeometry(b: CnhBoundary): MultiPolygon | null {
  const ring = (r: unknown): Position[] | null =>
    Array.isArray(r) &&
    r.length >= 4 &&
    r.every(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        p.every((n) => typeof n === 'number' && Number.isFinite(n)),
    )
      ? (r as Position[])
      : null;
  const polygon = (p: unknown): Polygon['coordinates'] | null => {
    if (!Array.isArray(p)) return null;
    const rings = p.map(ring);
    return rings.length && rings.every((r) => r !== null) ? (rings as Position[][]) : null;
  };
  const polys =
    b.type === 'Polygon' ? [polygon(b.coordinates)] : (b.coordinates as unknown[]).map(polygon);
  if (!polys.length || polys.some((p) => p === null)) return null;
  return { type: 'MultiPolygon', coordinates: polys as Polygon['coordinates'][] };
}
