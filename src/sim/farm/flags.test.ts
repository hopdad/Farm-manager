/**
 * Simulated Deere flags (docs/contracts-1f.md §7.4): deterministic, inside their fields, every
 * geometry kind, in the owning org, exactly one archived, and not part of the farm build (the
 * sim's determinism hashes don't move).
 */
import { booleanPointInPolygon, point } from '@turf/turf';
import { describe, expect, test } from 'vitest';
import { pinKindOfCategory } from '../../connectors/deere/fields/mapper';
import { buildDemoFarm } from './build';
import { SIM_FLAG_CATEGORIES, simFlags } from './flags';

const farm = buildDemoFarm(1);
const flags = simFlags(farm, 1);

describe('simFlags', () => {
  test('deterministic per seed; another seed gives other flags', () => {
    expect(simFlags(buildDemoFarm(1), 1)).toEqual(flags);
    expect(simFlags(farm, 2).map((f) => f.id)).not.toEqual(flags.map((f) => f.id));
  });

  test('a few flags on most fields, unique ids, every geometry kind', () => {
    const fields = new Set(flags.map((f) => f.fieldId));
    expect(fields.size).toBeGreaterThan(farm.fields.length / 2);
    expect(flags.length).toBeLessThanOrEqual(farm.fields.length * 2);
    expect(new Set(flags.map((f) => f.id)).size).toBe(flags.length);
    expect(new Set(flags.map((f) => f.geometry.type))).toEqual(
      new Set(['Point', 'LineString', 'Polygon']),
    );
  });

  test('every vertex lies inside its field, and the flag sits in the owning org', () => {
    const orgOfFarm = new Map(farm.farms.map((u) => [u.id, u.deereOrgId]));
    for (const f of flags) {
      const field = farm.fields.find((x) => x.id === f.fieldId);
      expect(field).toBeDefined();
      if (!field) continue;
      expect(f.deereFieldId).toBe(field.deereFieldId);
      expect(f.orgId).toBe(orgOfFarm.get(field.farmId));
      const pts =
        f.geometry.type === 'Point'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'LineString'
            ? f.geometry.coordinates
            : (f.geometry.coordinates[0] ?? []);
      for (const p of pts) {
        expect(booleanPointInPolygon(point(p), field.boundary)).toBe(true);
      }
    }
  });

  test('exactly one archived flag; categories map to pin kinds; times inside the 2026 season', () => {
    expect(flags.filter((f) => f.archived)).toHaveLength(1);
    const kinds = new Set(flags.map((f) => pinKindOfCategory(f.category.title)));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(SIM_FLAG_CATEGORIES.map((c) => pinKindOfCategory(c.title))).toEqual([
      'rock',
      'wet_hole',
      'tile_blowout',
      'washout',
      'hazard',
      'note',
    ]);
    for (const f of flags) {
      expect(f.createdTime >= '2026-04-01').toBe(true);
      expect(f.createdTime < '2026-09-01').toBe(true);
      expect(f.lastModifiedTime >= f.createdTime).toBe(true);
    }
  });
});
