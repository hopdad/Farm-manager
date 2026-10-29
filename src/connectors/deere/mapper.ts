/**
 * Pure Deere mappers: breadcrumb pages → raw items, raw item → NormalizedPosition.
 * Breadcrumbs exist only while working (plan §5), so every Deere fix is `deere_working`;
 * transport and idle positions come from the ELD.
 */
import { normalizeHeading } from '../../domain/fleet';
import type { NormalizedPosition, RawItem } from '../types';
import { type DeereBreadcrumb, type DeereBreadcrumbRaw, deereBreadcrumbRawSchema } from './schemas';

const KMH_PER_MPH = 1.609344;

const isoOf = (t: string) => new Date(t).toISOString();

export function deereBreadcrumbItems(
  orgId: string,
  machineId: string,
  crumbs: readonly DeereBreadcrumb[],
): RawItem<DeereBreadcrumbRaw>[] {
  return crumbs.map((breadcrumb) => ({
    externalId: `${orgId}:${machineId}:${isoOf(breadcrumb.eventTimestamp)}`,
    payload: { orgId, machineId, breadcrumb },
  }));
}

/** km/hr, kph, km/h → mph; mph as is; anything else unknown (null). */
export function speedToMph(speed: { value: number; unit: string } | undefined): number | null {
  if (!speed) return null;
  const u = speed.unit.toLowerCase().replace(/\s+/g, '');
  if (u === 'mph' || u === 'mi/hr' || u === 'mi/h') return Math.max(0, speed.value);
  if (u === 'km/hr' || u === 'km/h' || u === 'kph' || u === 'kmh') {
    return Math.max(0, Math.round((speed.value / KMH_PER_MPH) * 10) / 10);
  }
  return null;
}

export function mapDeereBreadcrumb(raw: unknown): NormalizedPosition[] {
  const r = deereBreadcrumbRawSchema.parse(raw);
  const b = r.breadcrumb;
  return [
    {
      source: 'deere',
      externalMachineId: r.machineId,
      sourceOrg: r.orgId,
      ts: isoOf(b.eventTimestamp),
      lng: b.point.lon,
      lat: b.point.lat,
      heading: b.heading ? normalizeHeading(b.heading.value) : null,
      speedMph: speedToMph(b.speed),
      engineOn: true,
      positionSource: 'deere_working',
    },
  ];
}
