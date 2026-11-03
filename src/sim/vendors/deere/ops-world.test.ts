import { describe, expect, test } from 'vitest';
import { createSimWorld } from '../../index';
import { CURRENT_CROP_YEAR, cropFor } from '../../seasons';
import type { SimClockState } from '../../types';
import type { DemoWorld } from '../../world';
import { simDayReportsOf } from '../context';
import { createStubSimWorld } from '../stub-world';
import {
  FULL_DAY_SPRAYER,
  fullDaySprayerCoverage,
  parseSimOperationId,
  type SimOpsContext,
  simCoverageRefused,
  simOperationId,
  simOperations,
  simOpsSeason,
  simPlanting,
  simToWall,
} from './ops-world';

const WALL = new Date('2026-10-31T13:00:00.000Z');

describe('simToWall (the current clock segment, inverted)', () => {
  const running: SimClockState = {
    anchorWall: '2026-10-31T12:00:00.000Z',
    anchorSim: '2026-10-15T11:00:00.000Z',
    speed: 30,
    paused: false,
  };

  test('running: wall_now − (sim_now − s) / speed', () => {
    // sim_now at WALL = anchorSim + 1 h × 30 = 2026-10-16T17:00Z; s an hour of sim before that.
    const s = new Date('2026-10-16T16:00:00.000Z');
    expect(simToWall(running, s, WALL).toISOString()).toBe('2026-10-31T12:58:00.000Z');
  });

  test('paused: stamps stay where they were (they never drift with the wall clock)', () => {
    const paused = { ...running, paused: true };
    const s = new Date('2026-10-15T10:30:00.000Z'); // 30 sim min before the pause
    const a = simToWall(paused, s, WALL);
    const b = simToWall(paused, s, new Date(WALL.getTime() + 3_600_000));
    expect(a.toISOString()).toBe('2026-10-31T11:59:00.000Z');
    expect(b).toEqual(a);
  });

  test('never after wall-now', () => {
    const future = new Date('2026-12-01T00:00:00.000Z');
    expect(simToWall(running, future, WALL)).toEqual(WALL);
  });
});

describe('simPlanting', () => {
  test('pure, in the usual windows for its crop', () => {
    const world = createSimWorld({ scenario: 'harvest-day' });
    for (const field of world.farm.fields) {
      const p = simPlanting(1, field, CURRENT_CROP_YEAR);
      expect(simPlanting(1, field, CURRENT_CROP_YEAR)).toEqual(p);
      expect(p.crop).toBe(cropFor(1, field, CURRENT_CROP_YEAR));
      const md = p.date.m * 100 + p.date.d;
      if (p.crop === 'corn') expect(md >= 424 && md <= 515).toBe(true);
      if (p.crop === 'soybeans') expect(md >= 504 && md <= 528).toBe(true);
      if (p.crop === 'wheat') expect(p.date.y).toBe(CURRENT_CROP_YEAR - 1);
      expect(p.minutes).toBeGreaterThanOrEqual(45);
    }
  });
});

describe('operation ids', () => {
  test('round-trip; a foreign id parses to null', () => {
    const id = simOperationId('field-blissfield-2', 'harvest', '2026');
    expect(id).not.toMatch(/[=+/]/);
    expect(parseSimOperationId(id)).toEqual({
      fieldKey: 'field-blissfield-2',
      kind: 'harvest',
      cropSeason: '2026',
      fullDay: false,
    });
    expect(parseSimOperationId(simOperationId('f', 'application', '2026', true))?.fullDay).toBe(
      true,
    );
    expect(parseSimOperationId('MjIzMDMxXzU4NDFkMDM2YTA2ZDkwMDk3MGYyNDJkNg')).toBeNull();
  });
});

function contextFor(
  world: DemoWorld | ReturnType<typeof createStubSimWorld>,
  simNow: Date,
  wall: Date = WALL,
): SimOpsContext {
  return {
    world,
    days: simDayReportsOf(world),
    now: wall,
    simNow,
    clock: {
      anchorWall: wall.toISOString(),
      anchorSim: simNow.toISOString(),
      speed: 1,
      paused: false,
    },
    knobs: {},
  };
}

describe('simOperations', () => {
  test('harvest-day at its start: one spring planting per field, nothing else', () => {
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const ops = simOperations(contextFor(world, world.startsAt));
    expect(ops).toHaveLength(world.farm.fields.length);
    expect(new Set(ops.map((o) => o.kind))).toEqual(new Set(['seeding']));
    for (const o of ops) {
      expect(o.cropSeason).toBe('2026');
      expect(Date.parse(o.endDate)).toBeLessThanOrEqual(WALL.getTime());
      expect(o.coverageRefused).toBe(simCoverageRefused(world, o.field));
    }
    expect(ops.some((o) => o.coverageRefused)).toBe(true);
  });

  test('a finished work range becomes an operation; one still running does not', () => {
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const work = [...world.dayReport(0).work].sort((a, b) => a.lastAt.localeCompare(b.lastAt));
    const first = work[0];
    if (!first) throw new Error('no work');
    const before = simOperations(contextFor(world, new Date(Date.parse(first.lastAt) - 1000)));
    expect(before.some((o) => o.kind === 'harvest' && o.field.id === first.fieldId)).toBe(false);
    const after = simOperations(contextFor(world, new Date(Date.parse(first.lastAt) + 1000)));
    const h = after.find((o) => o.kind === 'harvest' && o.field.id === first.fieldId);
    expect(h).toMatchObject({ crop: 'corn', acres: Math.round(first.acres * 10) / 10 });
    expect(h?.machines.map((m) => m.id)).toEqual([first.machineId]);
    expect(Date.parse(h?.endDate as string)).toBe(WALL.getTime() - 1000);
  });

  test('planting-day plants the corn itself: no spring planting for corn, early soybeans still', () => {
    const world = createSimWorld({ scenario: 'planting-day' }) as DemoWorld;
    const ops = simOperations(contextFor(world, world.startsAt));
    const crops = new Set(ops.map((o) => o.crop));
    expect(crops.has('corn')).toBe(false);
    for (const o of ops) {
      const p = simPlanting(1, o.field, CURRENT_CROP_YEAR);
      // Planted before May 5 (wheat: last fall).
      expect(p.date.y * 10_000 + p.date.m * 100 + p.date.d).toBeLessThanOrEqual(20260505);
    }
  });

  test('winter-idle (January): only the wheat planted last fall', () => {
    const world = createSimWorld({ scenario: 'winter-idle' }) as DemoWorld;
    const ops = simOperations(contextFor(world, world.startsAt));
    expect(ops.every((o) => o.crop === 'wheat')).toBe(true);
  });

  test('the stub world (no day reports) still serves its field planting', () => {
    const world = createStubSimWorld({ scenario: 'harvest-day' });
    const ops = simOperations(contextFor(world, world.startsAt));
    expect(ops.map((o) => o.kind)).toEqual(['seeding']);
  });

  test('the full-day knob adds one application on its field', () => {
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const field = world.farm.fields[2];
    const c = contextFor(world, world.startsAt);
    const ops = simOperations({
      ...c,
      knobs: { fullDay: { fieldKey: field?.key ?? '', at: WALL.toISOString() } },
    });
    const fd = ops.filter((o) => o.fullDay);
    expect(fd).toHaveLength(1);
    expect(fd[0]).toMatchObject({ kind: 'application', coverageRefused: false });
    expect(Date.parse(fd[0]?.endDate as string) - Date.parse(fd[0]?.startDate as string)).toBe(
      FULL_DAY_SPRAYER.seconds * 1000,
    );
  });
});

describe('the season served (D23: the season being harvested at the wall)', () => {
  /** The scenario's first harvest range, and a sim instant just after it ended. */
  function afterFirstHarvest(world: DemoWorld) {
    const work = world.dayReport(0).work.filter((w) => w.op === 'harvest');
    const first = [...work].sort((a, b) => a.lastAt.localeCompare(b.lastAt))[0];
    if (!first) throw new Error('no harvest');
    return { first, simNow: new Date(Date.parse(first.lastAt) + 60_000) };
  }

  test('at a January wall last season is served, plantings and harvest; this season is empty', () => {
    const JANUARY = new Date('2027-01-15T15:00:00.000Z');
    expect(simOpsSeason(JANUARY)).toBe(2026);
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const { first, simNow } = afterFirstHarvest(world);
    const c = contextFor(world, simNow, JANUARY);
    const last = simOperations(c, 2026);
    expect(simOperations(c)).toEqual(last);
    expect(simOperations(c, 2027)).toEqual([]);
    expect(new Set(last.map((o) => o.cropSeason))).toEqual(new Set(['2026']));
    // Every field's spring planting, at its written date in 2026 (wheat: the fall of 2025).
    const plantings = last.filter((o) => o.kind === 'seeding');
    expect(plantings).toHaveLength(world.farm.fields.length);
    for (const o of plantings) {
      const p = simPlanting(1, o.field, CURRENT_CROP_YEAR);
      const local = new Date(Date.parse(o.startDate) - 5 * 3_600_000); // EST/EDT within an hour
      expect(local.getUTCFullYear()).toBe(p.date.y);
      expect(local.getUTCMonth() + 1).toBe(p.date.m);
      expect(o.id).toBe(simOperationId(o.field.key, 'seeding', '2026'));
    }
    // The harvest the scenario finished, stamped in January's wall time, filed under 2026.
    const harvest = last.find((o) => o.kind === 'harvest' && o.field.id === first.fieldId);
    expect(harvest).toMatchObject({ cropSeason: '2026', crop: 'corn' });
    expect(Date.parse(harvest?.endDate as string)).toBe(JANUARY.getTime() - 60_000);
  });

  test('the stand-in moves to the next season on Aug 1 (America/Detroit), not on Jan 1', () => {
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const julyEnd = new Date('2027-08-01T03:59:00.000Z'); // Jul 31, 23:59 EDT
    const aug1 = new Date('2027-08-01T04:00:00.000Z'); // Aug 1, 00:00 EDT
    expect(simOpsSeason(new Date('2026-12-31T23:59:00-05:00'))).toBe(2026);
    expect(simOpsSeason(new Date('2027-01-01T00:00:00-05:00'))).toBe(2026);
    expect(simOpsSeason(julyEnd)).toBe(2026);
    expect(simOpsSeason(aug1)).toBe(2027);
    const before = simOperations(contextFor(world, world.startsAt, julyEnd));
    const after = simOperations(contextFor(world, world.startsAt, aug1));
    expect(before.every((o) => o.cropSeason === '2026')).toBe(true);
    expect(after.every((o) => o.cropSeason === '2027')).toBe(true);
    // From Aug 1 the plantings are this year's spring (2027), all ended by then.
    expect(after).toHaveLength(world.farm.fields.length);
    for (const o of after) {
      if (o.crop === 'wheat') expect(o.startDate.slice(0, 4)).toBe('2026');
      else expect(o.startDate.slice(0, 5)).toBe('2027-');
    }
  });

  test('the listing serves the cropSeason asked: the modelled one, and nothing for others', async () => {
    const JANUARY = new Date('2027-01-15T15:00:00.000Z');
    const world = createSimWorld({ scenario: 'harvest-day' }) as DemoWorld;
    const c = contextFor(world, world.startsAt, JANUARY);
    expect(simOperations(c, 2025)).toEqual([]);
    expect(simOperations(c, 2026).length).toBe(world.farm.fields.length);
  });
});

describe('fullDaySprayerCoverage', () => {
  test('one rectangle per second of a 12 h day, deterministic', () => {
    const world = createStubSimWorld({ scenario: 'harvest-day' });
    const field = world.farm.fields[0];
    if (!field) throw new Error('no field');
    const a = fullDaySprayerCoverage(field);
    expect(a.coordinates).toHaveLength(FULL_DAY_SPRAYER.seconds);
    expect(a.coordinates[0]?.[0]).toHaveLength(5);
    expect(fullDaySprayerCoverage(field)).toEqual(a);
    expect(JSON.stringify(a).length).toBeGreaterThan(3_000_000);
  });
});
