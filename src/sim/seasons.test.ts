import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from './farm/build';
import { CURRENT_CROP_YEAR, cropFor, SEASON_YEARS, simFieldSeasons } from './seasons';

const farm = buildDemoFarm(1);
const seasons = simFieldSeasons(farm);

describe('synthetic field seasons', () => {
  test('five completed seasons per field, unique keys, deterministic', () => {
    expect(seasons).toHaveLength(farm.fields.length * SEASON_YEARS.length);
    expect(new Set(seasons.map((s) => s.key)).size).toBe(seasons.length);
    expect(simFieldSeasons(buildDemoFarm(1))).toEqual(seasons);
    expect(Math.max(...seasons.map((s) => s.cropYear))).toBeLessThan(CURRENT_CROP_YEAR);
  });

  test('plausible rotations: corn and soybeans alternate, wheat now and then', () => {
    for (const f of farm.fields) {
      const crops = SEASON_YEARS.map((y) => cropFor(farm.seed, f, y));
      for (let i = 1; i < crops.length; i++) expect(crops[i]).not.toBe(crops[i - 1]);
    }
    const crops = new Set(seasons.map((s) => s.crop));
    expect(crops).toEqual(new Set(['corn', 'soybeans', 'wheat']));
    const corn2026 = farm.fields.filter((f) => cropFor(farm.seed, f, CURRENT_CROP_YEAR) === 'corn');
    expect(corn2026.length).toBeGreaterThan(10);
    expect(corn2026.length).toBeLessThan(30);
  });

  test('yields and dates in the usual SE Michigan ranges', () => {
    for (const s of seasons) {
      const [lo, hi] =
        s.crop === 'corn' ? [140, 230] : s.crop === 'soybeans' ? [38, 66] : [70, 110];
      expect(s.yieldBuAc).toBeGreaterThan(lo);
      expect(s.yieldBuAc).toBeLessThan(hi);
      expect(s.plantedOn < s.harvestedOn).toBe(true);
      expect(s.plantedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number(s.harvestedOn.slice(0, 4))).toBe(s.cropYear);
      expect(s.variety).toMatch(/^NF /);
    }
  });
});
