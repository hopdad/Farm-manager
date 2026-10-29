/**
 * Pure Deere mappers: breadcrumb pages → raw items, raw item → NormalizedPosition, plus the
 * geometry and unit helpers the 1f field / boundary / operation / flag syncs build on (Deere
 * rings and points → GeoJSON, flag geometry strings, ADAPT units). Breadcrumbs exist only while
 * working (plan §5), so every Deere fix is `deere_working`; transport and idle positions come
 * from the ELD.
 */
import type { MultiPolygon, Position } from 'geojson';
import { normalizeHeading } from '../../domain/fleet';
import type { NormalizedPosition, RawItem } from '../types';
import {
  type DeereBoundary,
  type DeereBreadcrumb,
  type DeereBreadcrumbRaw,
  type DeereFlag,
  type DeereFlagGeometry,
  type DeereLink,
  deereBreadcrumbRawSchema,
  deereFlagGeometrySchema,
} from './schemas';

const KMH_PER_MPH = 1.609344;
/** 1 acre = 0.40468564224 ha (international acre). */
export const ACRES_PER_HECTARE = 1 / 0.40468564224;

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

/**
 * km/h (Deere's ADAPT code `km1hr-1`, or km/hr, kph) → mph; mph (`mi1hr-1`) as is; anything
 * else unknown (null).
 */
export function speedToMph(speed: { value: number; unit: string } | undefined): number | null {
  if (!speed) return null;
  const u = speed.unit.toLowerCase().replace(/\s+/g, '');
  if (u === 'mph' || u === 'mi/hr' || u === 'mi/h' || u === 'mi1hr-1') {
    return Math.max(0, speed.value);
  }
  if (u === 'km/hr' || u === 'km/h' || u === 'kph' || u === 'kmh' || u === 'km1hr-1') {
    return Math.max(0, Math.round((speed.value / KMH_PER_MPH) * 10) / 10);
  }
  return null;
}

/** A breadcrumb's speed in mph, from the documented or the stand-in's shape. */
export function breadcrumbSpeedMph(b: DeereBreadcrumb): number | null {
  const s = b.speed as Record<string, unknown> | undefined;
  if (!s) return null;
  const value =
    typeof s.valueAsDouble === 'number'
      ? s.valueAsDouble
      : typeof s.value === 'number'
        ? s.value
        : null;
  const unit = typeof s.unit === 'string' ? s.unit : null;
  return value === null || unit === null ? null : speedToMph({ value, unit });
}

/** A breadcrumb's heading in degrees [0, 360), or null. */
export function breadcrumbHeading(b: DeereBreadcrumb): number | null {
  const h = b.heading as Record<string, unknown> | undefined;
  if (!h) return null;
  const v = Number(h.valueAsInteger ?? h.value);
  return Number.isFinite(v) ? normalizeHeading(v) : null;
}

/** 'Working', 'Idle', 'Transporting' or null, from either machineState shape. */
export function breadcrumbMachineState(b: DeereBreadcrumb): string | null {
  const m = b.machineState;
  if (m === undefined) return null;
  return typeof m === 'string' ? m : (m.value ?? null);
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
      heading: breadcrumbHeading(b),
      speedMph: breadcrumbSpeedMph(b),
      engineOn: true,
      positionSource: 'deere_working',
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Geometry and units for the field / boundary / operation / flag syncs (1f)
// ---------------------------------------------------------------------------------------------

/** The `uri` of the first link with `rel`, or null. */
export function deereLinkUri(links: readonly DeereLink[] | undefined, rel: string): string | null {
  return links?.find((l) => l.rel === rel)?.uri ?? null;
}

/** The last path segment of a link (the id it points to), or null. */
export function deereLinkId(links: readonly DeereLink[] | undefined, rel: string): string | null {
  const uri = deereLinkUri(links, rel);
  if (!uri) return null;
  const path = uri.split(/[?#;]/, 1)[0]?.replace(/\/+$/, '') ?? '';
  const id = path.slice(path.lastIndexOf('/') + 1).trim();
  return id ? decodeURIComponent(id) : null;
}

function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/**
 * A Deere boundary as a GeoJSON MultiPolygon ([lon, lat], rings closed, each polygon's exterior
 * ring first). A polygon with no exterior ring is skipped; none at all is an error.
 */
export function deereBoundaryToMultiPolygon(b: Pick<DeereBoundary, 'multipolygons'>): MultiPolygon {
  const polygons: Position[][][] = [];
  for (const p of b.multipolygons) {
    const ring = (r: (typeof p.rings)[number]) =>
      closeRing(r.points.map((pt): Position => [pt.lon, pt.lat]));
    const exterior = p.rings.filter((r) => r.type === 'exterior');
    const interior = p.rings.filter((r) => r.type === 'interior');
    // Deere allows several exterior rings in one polygon: each becomes its own polygon, and
    // the interior rings stay with the first.
    exterior.forEach((e, i) => {
      polygons.push([ring(e), ...(i === 0 ? interior.map(ring) : [])]);
    });
  }
  if (polygons.length === 0) throw new RangeError('Deere boundary has no exterior ring');
  return { type: 'MultiPolygon', coordinates: polygons };
}

/** A flag's geometry (GET sends it as a JSON string), validated: Point, LineString or Polygon. */
export function deereFlagGeometry(flag: Pick<DeereFlag, 'geometry'>): DeereFlagGeometry {
  const g =
    typeof flag.geometry === 'string' ? (JSON.parse(flag.geometry) as unknown) : flag.geometry;
  return deereFlagGeometrySchema.parse(g);
}

/** An area measurement in acres (ha or ac, as Deere's `unit` / `unitId`), else null. */
export function areaAcres(m: { value: number; unit: string } | undefined): number | null {
  if (!m) return null;
  const u = m.unit.toLowerCase();
  if (u === 'ac' || u === 'acre' || u === 'acres') return m.value;
  if (u === 'ha' || u === 'hectare' || u === 'hectares') return m.value * ACRES_PER_HECTARE;
  return null;
}
