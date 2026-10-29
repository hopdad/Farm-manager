/**
 * Field-entrance geofences of the simulated farm (plan 1a: "geofences (elevators, shop, field
 * entrances)"). The demo seed already writes elevator yards, the shop and the bin site; this pure
 * module adds one `field_entrance` geofence per field so the fleet positions step records when a
 * truck or cart turns in or waits at a field (contracts-m1 §1.2).
 *
 * Deliberately NOT imported by ./build.ts: the farm and the sim's determinism hashes don't move.
 * Ids are deterministic (`demoId('entrance-<field key>')`), seeded with source 'demo' and
 * source_id = the key, like every other demo row.
 *
 * Shape: a rectangle on the section-line road at the entrance, ENTRANCE_ALONG_M either way along
 * the road, from ENTRANCE_ROAD_SIDE_M past the road centre line to ENTRANCE_FIELD_SIDE_M towards
 * the field. The field boundary is inset ROAD_SIDE_INSET_M (15 m) from the centre line, so the
 * geofence ends just short of the crop: a combine working the headland is not "at the entrance".
 */
import type { Polygon } from 'geojson';
import { demoId } from '../../domain/ids';
import { offsetLngLat } from '../geo/lnglat';
import type { LngLat, SimField } from '../types';
import { ROAD_SIDE_INSET_M } from './build';

/** Half-length of the geofence along the road (m). */
export const ENTRANCE_ALONG_M = 40;
/** How far it reaches past the road centre line, away from the field (m). */
export const ENTRANCE_ROAD_SIDE_M = 12;
/** How far it reaches from the centre line towards the field (m); less than the inset. */
export const ENTRANCE_FIELD_SIDE_M = ROAD_SIDE_INSET_M - 1;

export interface SimFieldEntranceGeofence {
  id: string;
  /** Seeded as source_id (source 'demo'). */
  key: string;
  kind: 'field_entrance';
  name: string;
  fieldId: string;
  geofence: Polygon;
}

/** The demo seed key of a field's entrance geofence. */
export function fieldEntranceKey(fieldKey: string): string {
  return `entrance-${fieldKey}`;
}

/** Unit vector (east, north) from the entrance towards the field, snapped to the road grid. */
function towardsField(field: SimField): [number, number] {
  const ring = field.boundary.coordinates[0]?.[0] ?? [];
  const pts = ring.slice(0, -1);
  if (!pts.length) throw new Error(`field ${field.key} has an empty boundary`);
  const cx = pts.reduce((s, p) => s + (p[0] as number), 0) / pts.length;
  const cy = pts.reduce((s, p) => s + (p[1] as number), 0) / pts.length;
  const [ex, ey] = field.entrance;
  // Compare in metres (a degree of longitude is shorter than one of latitude here).
  const dx = (cx - ex) * Math.cos((ey * Math.PI) / 180);
  const dy = cy - ey;
  if (Math.abs(dx) >= Math.abs(dy)) return [Math.sign(dx) || 1, 0];
  return [0, Math.sign(dy) || 1];
}

const round8 = (v: number) => Math.round(v * 1e8) / 1e8;

/** The entrance rectangle of one field (counter-clockwise exterior ring, RFC 7946). */
export function fieldEntrancePolygon(field: SimField): Polygon {
  const away = towardsField(field);
  const along: [number, number] = [Math.abs(away[1]), Math.abs(away[0])];
  const at = (u: number, w: number): LngLat => {
    const p = offsetLngLat(field.entrance, along[0] * u + away[0] * w, along[1] * u + away[1] * w);
    return [round8(p[0]), round8(p[1])];
  };
  const a = ENTRANCE_ALONG_M;
  let ring: LngLat[] = [
    at(-a, -ENTRANCE_ROAD_SIDE_M),
    at(a, -ENTRANCE_ROAD_SIDE_M),
    at(a, ENTRANCE_FIELD_SIDE_M),
    at(-a, ENTRANCE_FIELD_SIDE_M),
  ];
  if (signedArea(ring) < 0) ring = ring.reverse();
  return { type: 'Polygon', coordinates: [[...ring, ring[0] as LngLat]] };
}

function signedArea(ring: readonly LngLat[]): number {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k] as LngLat;
    const q = ring[(k + 1) % ring.length] as LngLat;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** One `field_entrance` geofence per field of the simulated farm, in field order. */
export function fieldEntranceGeofences(farm: {
  fields: readonly SimField[];
}): SimFieldEntranceGeofence[] {
  return farm.fields.map((f) => {
    const key = fieldEntranceKey(f.key);
    return {
      id: demoId(key),
      key,
      kind: 'field_entrance',
      name: `${f.name} entrance`,
      fieldId: f.id,
      geofence: fieldEntrancePolygon(f),
    };
  });
}
