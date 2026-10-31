/**
 * Simulated Deere flags (slice 1f, docs/contracts-1f.md §7.4; owner: deere-data): a few flags on
 * the demo farm's Deere fields, the way an operator drops them in Operations Center (a rock, a wet
 * spot, a tile blowout, a washout, a hazard), as Points, LineStrings and Polygons inside the
 * field. A pure function of the farm and a seeded rng: the Deere stand-in's `fields` module serves
 * them and the replay fixture builder writes them, so sim and replay show the same pins.
 *
 * NOT imported by ./build.ts: the sim's determinism hashes don't move.
 */
import type { LineString, Point, Polygon, Position } from 'geojson';
import { deterministicId } from '../../domain/ids';
import { rngFor } from '../rng';
import type { SimFarm, SimField } from '../types';

/** A Deere reference flag category (FlagCategory.categoryTitle) and its sim id. */
export interface SimFlagCategory {
  id: string;
  title: string;
}

/** The categories the simulated operators use (Deere's reference list has "Rocks", "Weeds" …). */
export const SIM_FLAG_CATEGORIES: readonly SimFlagCategory[] = [
  'Rocks',
  'Wet Spot',
  'Tile Blowout',
  'Washout',
  'Hazard',
  'Weeds',
].map((title) => ({ id: deterministicId('sim-deere', `flag-category:${title}`), title }));

const NOTES: Record<string, readonly string[]> = {
  Rocks: ['Big rock, lift the header', 'Rock pile at the headland', 'Stone, mark before tillage'],
  'Wet Spot': ['Wet spot: go around in spring', 'Stays wet after a rain', 'Soft ground, got stuck'],
  'Tile Blowout': ['Tile blowout, fix after harvest', 'Tile hole opening up', 'Broken tile main'],
  Washout: ['Washout along the waterway', 'Gully forming on the slope'],
  Hazard: ['Power pole guy wire', 'Old well cap', 'Drop-off at the ditch bank'],
  Weeds: ['Waterhemp patch', 'Marestail escape'],
};

export interface SimFlag {
  /** Deere flag id (a GUID). */
  id: string;
  /** The field it sits on and its Deere id in the owning org. */
  fieldId: string;
  deereFieldId: string;
  /** The org that owns the field (the farm unit's Deere org). */
  orgId: string;
  category: SimFlagCategory;
  notes: string;
  geometry: Point | LineString | Polygon;
  archived: boolean;
  /** UTC ISO (fixed dates in the 2026 season). */
  createdTime: string;
  lastModifiedTime: string;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A point at fractions (fx, fy) of the field's bounding box. */
function pointIn(f: SimField, fx: number, fy: number): Position {
  const ring = f.boundary.coordinates[0]?.[0] ?? [];
  const xs = ring.map((p) => p[0] as number);
  const ys = ring.map((p) => p[1] as number);
  const w = Math.min(...xs);
  const s = Math.min(...ys);
  return [r6(w + (Math.max(...xs) - w) * fx), r6(s + (Math.max(...ys) - s) * fy)];
}

const SEASON_START = Date.parse('2026-04-01T12:00:00Z');
const SEASON_DAYS = 150;

/**
 * The demo farm's flags: about two fields in three get one or two, in the owning org of the
 * field. The first flag of the farm is archived (resolved in Operations Center), so the
 * "an archived flag resolves its pin" path runs in sim. Deterministic for (farm, seed).
 */
export function simFlags(farm: SimFarm, seed = 1): SimFlag[] {
  const orgOfFarm = new Map(farm.farms.map((u) => [u.id, u.deereOrgId]));
  const out: SimFlag[] = [];
  for (const f of farm.fields) {
    const orgId = orgOfFarm.get(f.farmId);
    if (!orgId) continue;
    const rng = rngFor(seed, 'deere-flags', f.key);
    if (!rng.chance(0.65)) continue;
    const n = rng.chance(0.35) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const category = rng.pick(SIM_FLAG_CATEGORIES);
      const notes = rng.pick(NOTES[category.title] ?? ['Check this spot']);
      const cx = rng.range(0.15, 0.85);
      const cy = rng.range(0.15, 0.85);
      let geometry: SimFlag['geometry'];
      if (category.title === 'Washout') {
        geometry = {
          type: 'LineString',
          coordinates: [pointIn(f, cx - 0.1, cy - 0.05), pointIn(f, cx + 0.1, cy + 0.05)],
        };
      } else if (category.title === 'Wet Spot' || category.title === 'Weeds') {
        const d = 0.04;
        geometry = {
          type: 'Polygon',
          coordinates: [
            [
              pointIn(f, cx - d, cy - d),
              pointIn(f, cx + d, cy - d),
              pointIn(f, cx + d, cy + d),
              pointIn(f, cx - d, cy + d),
              pointIn(f, cx - d, cy - d),
            ],
          ],
        };
      } else {
        geometry = { type: 'Point', coordinates: pointIn(f, cx, cy) };
      }
      const created =
        SEASON_START + rng.int(0, SEASON_DAYS) * 86_400_000 + rng.int(0, 600) * 60_000;
      const modified = created + rng.int(0, 120) * 60_000;
      out.push({
        id: deterministicId('sim-deere', `flag:${f.key}:${i}`),
        fieldId: f.id,
        deereFieldId: f.deereFieldId,
        orgId,
        category,
        notes,
        geometry,
        archived: out.length === 0,
        createdTime: new Date(created).toISOString(),
        lastModifiedTime: new Date(modified).toISOString(),
      });
    }
  }
  return out;
}
