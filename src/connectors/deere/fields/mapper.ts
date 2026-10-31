/**
 * Pure mappers of the deere.fields sync (slice 1f, docs/contracts-1f.md §5.2, §5.7; owner:
 * deere-data): a field as one org lists it (with its farm, client and active boundary) →
 * NormalizedField; a flag → NormalizedFlag and the pin kind of its category; an Equipment API
 * item → NormalizedMachine with the kind from its ISG type; an engine-hours report →
 * NormalizedVehicleStat. The 1a geometry helpers (../mapper.ts) are reused, never changed.
 */
import type { MachineKind } from '../../../domain/fleet';
import type { PinKind } from '../../../domain/pins';
import type {
  NormalizedBoundary,
  NormalizedField,
  NormalizedFlag,
  NormalizedMachine,
  NormalizedRef,
  NormalizedVehicleStat,
} from '../../types';
import { areaAcres, deereBoundaryToMultiPolygon, deereFlagGeometry, deereLinkId } from '../mapper';
import type { DeereBoundary, DeereEquipment } from '../schemas';
import {
  type DeereEngineHoursRaw,
  type DeereFieldRaw,
  type DeereFlagWithCategory,
  type DeereNamedRef,
  deereEngineHoursRawSchema,
  deereFieldRawSchema,
} from './schemas';

const isoOf = (t: string | undefined | null): string | null =>
  t ? new Date(t).toISOString() : null;

const norm = (s: string) =>
  s
    .replace(/[\s_-]+/g, ' ')
    .trim()
    .toLowerCase();

// ---------------------------------------------------------------------------------------------
// Fields and boundaries
// ---------------------------------------------------------------------------------------------

/** The first not-archived ref of an embed (else the first one), as a NormalizedRef. */
function firstRef(refs: readonly DeereNamedRef[] | undefined): NormalizedRef | null {
  const r = refs?.find((x) => !x.archived) ?? refs?.[0];
  return r ? { externalId: r.id, name: r.name } : null;
}

/**
 * A field's active boundary from the org's boundary listing: the boundaries that link this field,
 * `active` and not archived; the latest modified when Deere marks more than one active.
 */
export function activeBoundaryOf(
  fieldId: string,
  boundaries: readonly DeereBoundary[],
): DeereBoundary | null {
  const mine = boundaries.filter(
    (b) => b.active === true && b.archived !== true && deereLinkId(b.links, 'field') === fieldId,
  );
  mine.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  return mine[0] ?? null;
}

/** A Deere boundary as a NormalizedBoundary, or null when it has no usable geometry or id. */
export function mapDeereBoundary(
  orgId: string,
  fieldExternalId: string,
  b: DeereBoundary,
): NormalizedBoundary | null {
  if (!b.id) return null;
  let geom: NormalizedBoundary['geom'];
  try {
    geom = deereBoundaryToMultiPolygon(b);
  } catch {
    return null;
  }
  return {
    source: 'deere',
    sourceOrg: orgId,
    externalId: b.id,
    fieldExternalId,
    name: b.name?.trim() || null,
    geom,
    areaAc: b.area ? areaAcres({ value: b.area.valueAsDouble, unit: b.area.unit ?? '' }) : null,
    active: b.active ?? false,
    archived: b.archived ?? false,
    modifiedAt: isoOf(b.modifiedTime),
  };
}

/** One field item of stream `fields`, normalized, with what the writer needs about its org. */
export interface DeereFieldItem {
  field: NormalizedField;
  orgName: string | null;
  /** The home org of the run (decision 8); null = none known (nothing is created). */
  homeOrgId: string | null;
}

export function mapDeereField(raw: unknown): DeereFieldItem[] {
  const r: DeereFieldRaw = deereFieldRawSchema.parse(raw);
  const f = r.field;
  const name = f.name.trim() || f.id;
  return [
    {
      field: {
        source: 'deere',
        sourceOrg: r.orgId,
        externalId: f.id,
        name,
        farm: firstRef(f.farms?.farms),
        client: firstRef(f.clients?.clients),
        archived: f.archived ?? false,
        boundary: r.boundary ? mapDeereBoundary(r.orgId, f.id, r.boundary) : null,
        modifiedAt: isoOf(f.lastModifiedTime),
      },
      orgName: r.orgName,
      homeOrgId: r.homeOrgId,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Flags → pins
// ---------------------------------------------------------------------------------------------

/**
 * The pin kind a flag category names (PIN_KINDS), else 'note'. Deere's reference categories are
 * titles such as "Rocks", "Weeds", "Wet Spot"; orgs add their own, so the match is lenient
 * (plural, case, spaces and dashes don't matter) and anything unknown is a note.
 */
export function pinKindOfCategory(category: string | null | undefined): PinKind {
  if (!category) return 'note';
  const c = norm(category);
  if (/\btile\b/.test(c)) return 'tile_blowout';
  if (/\bwash ?outs?\b|\berosion\b|\bgull(y|ies)\b|\bwaterways?\b|\bditch(es)?\b/.test(c)) {
    return 'washout';
  }
  if (/\bwet\b|\bwater ?holes?\b|\bpond(s|ing)?\b|\bslough\b|\bmud\b|\bstanding water\b/.test(c)) {
    return 'wet_hole';
  }
  if (/\brocks?\b|\bstones?\b|\bboulders?\b/.test(c)) return 'rock';
  if (
    /\bhazards?\b|\bobstacles?\b|\bpoles?\b|\bpower ?lines?\b|\bwells?\b|\bstumps?\b|\bdanger\b|\bsink ?holes?\b|\bholes?\b|\bdrop ?offs?\b/.test(
      c,
    )
  ) {
    return 'hazard';
  }
  return 'note';
}

/** The flag's category title (embedded with `embed=flagCategory`), or null. */
export function flagCategoryOf(flag: DeereFlagWithCategory): string | null {
  const c = flag.flagCategory;
  const title = (c?.categoryTitle ?? c?.name ?? '').trim();
  return title || null;
}

/** A flag as a NormalizedFlag; null when its geometry isn't a Point, LineString or Polygon. */
export function mapDeereFlag(orgId: string, flag: DeereFlagWithCategory): NormalizedFlag | null {
  let geometry: NormalizedFlag['geometry'];
  try {
    const g = deereFlagGeometry(flag);
    geometry = { type: g.type, coordinates: g.coordinates } as NormalizedFlag['geometry'];
  } catch {
    return null;
  }
  return {
    source: 'deere',
    sourceOrg: orgId,
    externalId: flag.id,
    fieldExternalId: deereLinkId(flag.links, 'field'),
    geometry,
    note: flag.notes?.trim() || null,
    category: flagCategoryOf(flag),
    archived: flag.archived ?? false,
    createdAt: isoOf(flag.createdTime),
    modifiedAt: isoOf(flag.lastModifiedTime),
  };
}

// ---------------------------------------------------------------------------------------------
// Equipment → machines
// ---------------------------------------------------------------------------------------------

/**
 * A MachineKind from a Deere equipment type name (`isgType.name`, else the deprecated
 * `type.name`), or null when it doesn't name one this app tracks. The docs show only
 * "Combine", "Tractor" and "Scraper"; the full ISG list needs `GET /equipmentISGTypes` on a real
 * account, so the match is lenient (`4WD Tractor`, `Self-Propelled Sprayer`, …). Loaders, utility
 * vehicles (Gator), construction and forestry equipment and generic trucks don't map (contracts-1f
 * §5.7): they are listed once on /admin/connectors instead. // doc-derived, confirm
 */
export function machineKindOfType(name: string | null | undefined): MachineKind | null {
  if (!name) return null;
  const t = norm(name);
  if (/\bloaders?\b|\bgator\b|\butility vehicle\b|\bskid\b|\bexcavator\b|\bdozer\b/.test(t)) {
    return null;
  }
  if (/\bcombines?\b/.test(t)) return 'combine';
  if (/\bsprayers?\b|\bapplicators?\b|\bfloaters?\b/.test(t)) return 'sprayer';
  if (/\bgrain carts?\b/.test(t)) return 'grain_cart';
  if (/\bplanters?\b|\bseeders?\b|\bair drills?\b/.test(t)) return 'planter';
  if (/\btractors?\b/.test(t) && !/\btruck tractor\b/.test(t)) return 'tractor';
  if (/\bpick ?ups?\b/.test(t)) return 'pickup';
  if (/\bdrones?\b|\buav\b/.test(t)) return 'drone';
  return null;
}

/** Kind of an Equipment API item: its ISG type, falling back to the deprecated EquipmentType. */
export function deereMachineKind(e: Pick<DeereEquipment, 'isgType' | 'type'>): MachineKind | null {
  return machineKindOfType(e.isgType?.name) ?? machineKindOfType(e.type?.name);
}

/** The type name an unmappable machine is listed under (`extra.unmappedKinds`). */
export function deereTypeName(e: Pick<DeereEquipment, 'isgType' | 'type'>): string {
  return e.isgType?.name?.trim() || e.type?.name?.trim() || 'unknown';
}

/** One equipment item, normalized, with what the writer needs beyond NormalizedMachine. */
export interface DeereMachineItem {
  machine: NormalizedMachine;
  /** The ISG type name (else the EquipmentType's), for the unmappable list. */
  typeName: string;
  archived: boolean;
  telematicsCapable: boolean;
}

/**
 * An Equipment API item as a machine, keyed by its `principalId` (the id the /platform machine
 * paths and the ('deere', 'machine', …) refs use, never the organization-equipment `id`). Null
 * when it has no principalId.
 */
export function mapDeereEquipment(orgId: string, e: DeereEquipment): DeereMachineItem | null {
  if (!e.principalId) return null;
  const year = e.modelYear && /^\d{4}$/.test(e.modelYear) ? Number(e.modelYear) : null;
  const name = e.name?.trim() || e.serialNumber?.trim() || `Deere ${e.principalId}`;
  return {
    machine: {
      source: 'deere',
      sourceOrg: orgId,
      externalId: e.principalId,
      name,
      kind: deereMachineKind(e),
      make: e.make?.name?.trim() || null,
      model: e.model?.name?.trim() || null,
      year: year !== null && year >= 1900 && year <= 2100 ? year : null,
      vin: e.serialNumber?.trim() || null,
    },
    typeName: deereTypeName(e),
    archived: e.archived ?? false,
    telematicsCapable: e.telematicsCapable ?? true,
  };
}

// ---------------------------------------------------------------------------------------------
// Engine hours
// ---------------------------------------------------------------------------------------------

/** Hours from a reading (`unit` "Hours"; minutes and seconds converted), or null. */
export function engineHoursOf(reading: { valueAsDouble: number; unit?: string }): number | null {
  const v = reading.valueAsDouble;
  if (!Number.isFinite(v) || v < 0) return null;
  const u = norm(reading.unit ?? 'hours');
  let hours: number;
  if (['hours', 'hour', 'hr', 'hrs', 'h'].includes(u)) hours = v;
  else if (['minutes', 'minute', 'min', 'mins'].includes(u)) hours = v / 60;
  else if (['seconds', 'second', 'sec', 's'].includes(u)) hours = v / 3600;
  else return null;
  return Math.round(hours * 10) / 10;
}

export function mapDeereEngineHours(raw: unknown): NormalizedVehicleStat[] {
  const r: DeereEngineHoursRaw = deereEngineHoursRawSchema.parse(raw);
  const hours = engineHoursOf(r.report.reading);
  if (hours === null) return [];
  return [
    {
      source: 'deere',
      externalMachineId: r.principalId,
      sourceOrg: r.orgId,
      ts: new Date(r.report.reportTime).toISOString(),
      engineHours: hours,
    },
  ];
}
