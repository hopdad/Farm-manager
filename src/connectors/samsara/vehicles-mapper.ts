/**
 * Samsara vehicle list → the port's NormalizedVehicle (slice 1f.2, terminal-pickups; the pickups
 * route, docs/contracts-1f.md §B.4.1, §B.4.5). Pure.
 *
 *  - kind: the vehicle's tag names through VEHICLE_KIND_TAGS (`vehicleKindFromTags`; a kind set on
 *    /admin always wins, in the writer).
 *  - via (machines.telematics_via): Samsara's API marks no vehicle as Ford Pro or Stellantis
 *    sourced, so it is INFERRED (doc-derived, confirm on a recording of the farm's org,
 *    developers.samsara.com/reference/listvehicles): a vehicle with NO Samsara gateway is fed by
 *    its carmaker's cloud: a Ford → `ford_pro`, a Ram / Dodge / Chrysler / Jeep → `stellantis`; an
 *    asset gateway (AG*) → `gateway`; a vehicle gateway (VG*) on a vehicle tagged a pickup →
 *    `obd_device` (a plug-in OBD-II gateway); anything else says nothing (null leaves the column).
 */
import {
  DEFAULT_VEHICLE_KIND_TAGS,
  type TelematicsVia,
  type VehicleKind,
  type VehicleKindTagRule,
  vehicleKindFromTags,
} from '../../domain/vehicles';
import type { NormalizedVehicle } from '../types';
import type { SamsaraVehicle, SamsaraVehicleRaw } from './vehicles-schemas';

/** Makes whose connected vehicles Samsara reads through Stellantis Mobilisights (its marketplace page). */
const STELLANTIS_MAKES = new Set(['ram', 'dodge', 'chrysler', 'jeep']);

/** How Samsara gets a vehicle's data, as far as its record tells (see the file header). */
export function samsaraVehicleVia(
  v: Pick<SamsaraVehicle, 'gateway' | 'make'>,
  kind: VehicleKind | null,
): TelematicsVia | null {
  const gw = (v.gateway?.model ?? '').trim().toUpperCase();
  if (gw) {
    if (gw.startsWith('AG')) return 'gateway';
    if (gw.startsWith('VG') && kind === 'pickup') return 'obd_device';
    return null;
  }
  if (!v.gateway) {
    const make = (v.make ?? '').trim().toLowerCase();
    if (make === 'ford') return 'ford_pro';
    if (STELLANTIS_MAKES.has(make)) return 'stellantis';
  }
  return null;
}

const yearOf = (y: SamsaraVehicle['year']): number | null => {
  const n = typeof y === 'number' ? y : Number.parseInt(y ?? '', 10);
  return Number.isInteger(n) && n > 1900 && n < 2200 ? n : null;
};

export function mapSamsaraVehicle(
  raw: SamsaraVehicleRaw,
  rules: readonly VehicleKindTagRule[] = DEFAULT_VEHICLE_KIND_TAGS,
): NormalizedVehicle[] {
  const v = raw.vehicle;
  const tags = (v.tags ?? []).map((t) => t.name).filter(Boolean);
  const kindFromTags = vehicleKindFromTags(tags, rules);
  return [
    {
      source: 'samsara',
      sourceOrg: '',
      externalId: v.id,
      name: v.name ?? v.id,
      tags,
      kindFromTags,
      via: samsaraVehicleVia(v, kindFromTags),
      make: v.make ?? null,
      model: v.model ?? null,
      year: yearOf(v.year),
      vin: v.vin ?? null,
    },
  ];
}
