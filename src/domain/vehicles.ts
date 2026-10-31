/**
 * Telematics vehicles (slice 1f.2, docs/contracts-1f.md part B): what a vehicle IS (its
 * `farm.machines.kind`: not every telematics vehicle is a semi) and HOW its data reaches the
 * vendor (`farm.machines.telematics_via`: a carmaker cloud, an asset gateway).
 *
 *  - Kind: set from a vendor tag (`vehicleKindFromTags` with the VEHICLE_KIND_TAGS rules) or by
 *    hand on /admin. A hand-set kind (`kind_set_by = 'admin'`) always wins: a vendor tag never
 *    changes it again (`nextVehicleKind`).
 *  - Via: where the vendor reports it (Samsara's Ford Pro and Stellantis integrations, an asset
 *    gateway on a machine with no OEM API). It decides which stats the route can report: a stat
 *    the route doesn't report shows as "not reported", never 0 (src/connectors/vendors.ts
 *    `statsNotReported`).
 *
 * Pure TS + zod. Owned by the foundation (contract file).
 */
import { z } from 'zod';
import { MACHINE_KINDS, type MachineKind, POSITION_VENDOR_PATTERN } from './fleet';

/** Kinds a vendor tag or /admin may give a telematics vehicle. */
export const VEHICLE_KINDS = [
  'semi',
  'pickup',
  'service_truck',
] as const satisfies readonly MachineKind[];
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** Who set farm.machines.kind last (machines.kind_set_by). */
export const KIND_SET_BY = ['default', 'vendor', 'admin'] as const;
export type KindSetBy = (typeof KIND_SET_BY)[number];

/**
 * Known `telematics_via` values. The column takes any id of the position-vendor format, so a
 * new route needs no migration; these are the ones the code knows how to label.
 *  - `ford_pro`: Ford's embedded modem through Ford Pro (Samsara, Motive, Geotab integrations).
 *  - `stellantis`: Ram / Jeep / Chrysler through Stellantis Mobilisights (ex Free2move).
 *  - `gateway`: an aftermarket asset gateway on the machine (Samsara AG26 / AG46P with a J1939
 *    harness): positions, gateway engine seconds, fuel when the ECM is readable.
 *  - `obd_device`: a plug-in OBD-II vehicle gateway (Samsara VG on a pickup).
 */
export const TELEMATICS_VIAS = ['ford_pro', 'stellantis', 'gateway', 'obd_device'] as const;
export type TelematicsVia = (typeof TELEMATICS_VIAS)[number];

export const telematicsViaSchema = z.string().regex(POSITION_VENDOR_PATTERN);

/** One rule: a vendor tag name (case-insensitive, trimmed) → a vehicle kind. */
export interface VehicleKindTagRule {
  tag: string;
  kind: VehicleKind;
}

/** VEHICLE_KIND_TAGS's default: `semi:Semi,pickup:Pickup,service_truck:Service truck`. */
export const DEFAULT_VEHICLE_KIND_TAGS: readonly VehicleKindTagRule[] = [
  { tag: 'semi', kind: 'semi' },
  { tag: 'pickup', kind: 'pickup' },
  { tag: 'service truck', kind: 'service_truck' },
];

/**
 * Parse VEHICLE_KIND_TAGS: comma-separated `<kind>:<tag name>` pairs, e.g.
 * `pickup:Pickups,service_truck:Service,semi:Grain trucks`. Throws on an unknown kind or an
 * empty tag (config validation turns it into a fix-it message). '' = the default rules.
 */
export function parseVehicleKindTags(value: string | undefined | null): VehicleKindTagRule[] {
  const v = (value ?? '').trim();
  if (!v) return [...DEFAULT_VEHICLE_KIND_TAGS];
  return v.split(',').map((pair) => {
    const i = pair.indexOf(':');
    const kind = (i < 0 ? '' : pair.slice(0, i)).trim();
    const tag = (i < 0 ? '' : pair.slice(i + 1)).trim();
    if (!(VEHICLE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`'${pair.trim()}': the kind must be one of ${VEHICLE_KINDS.join(', ')}`);
    }
    if (!tag) throw new Error(`'${pair.trim()}': a tag name is required after the colon`);
    return { tag: tag.toLowerCase(), kind: kind as VehicleKind };
  });
}

/** The kind the vendor's tags name (first matching rule wins), or null when none matches. */
export function vehicleKindFromTags(
  tags: readonly string[],
  rules: readonly VehicleKindTagRule[] = DEFAULT_VEHICLE_KIND_TAGS,
): VehicleKind | null {
  const have = new Set(tags.map((t) => t.trim().toLowerCase()));
  for (const r of rules) if (have.has(r.tag.toLowerCase())) return r.kind;
  return null;
}

/**
 * What a vendor's view of a vehicle does to farm.machines.kind / kind_set_by: an admin-set kind
 * never changes; a vendor tag kind replaces a default or an earlier vendor kind; no tag kind =
 * no change.
 */
export function nextVehicleKind(
  current: { kind: MachineKind; kindSetBy: KindSetBy },
  fromVendor: VehicleKind | null,
): { kind: MachineKind; kindSetBy: KindSetBy } {
  if (current.kindSetBy === 'admin' || fromVendor === null) return current;
  return { kind: fromVendor, kindSetBy: 'vendor' };
}

export const vehicleKindSchema = z.enum(VEHICLE_KINDS);
export const kindSetBySchema = z.enum(KIND_SET_BY);
export const machineKindSchema = z.enum(MACHINE_KINDS);
