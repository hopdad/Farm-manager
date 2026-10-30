import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ACTIVITIES } from '../domain/fleet';
import { buildSimFarm, createSimWorld } from './index';
import { localDayTime } from './time';
import { SCENARIO_NAMES, type ScenarioName, type SimMachineSample } from './types';
import { createDemoWorld, HORIZON_DAYS } from './world';

/** Samples of every machine (or the first `only`) every 10 minutes for 16 hours from the start. */
function sampleHash(scenario: ScenarioName, seed = 1, only?: number): string {
  const w = createSimWorld({ scenario, seed });
  const h = createHash('sha256');
  const t0 = w.startsAt.getTime();
  const machines = only === undefined ? w.farm.machines : w.farm.machines.slice(0, only);
  for (let k = 0; k < 96; k++) {
    const t = new Date(t0 + k * 10 * 60_000);
    for (const m of machines) h.update(JSON.stringify(w.machineAt(m.id, t)));
  }
  return h.digest('hex');
}

/** Ray-casting point-in-polygon on one ring of [lng, lat]. */
function pointInRing([x, y]: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const local = (iso: string) => {
  // 'YYYY-MM-DD HH:MM' in farm time -> Date
  const [d, t] = iso.split(' ');
  const [y, m, day] = (d ?? '').split('-').map(Number);
  const [hh, mm] = (t ?? '').split(':').map(Number);
  return new Date(
    localDayTime(
      Math.floor(Date.UTC(y ?? 0, (m ?? 1) - 1, day ?? 1) / 86_400_000),
      (hh ?? 0) * 60 + (mm ?? 0),
    ),
  );
};

describe('determinism', () => {
  test('same (scenario, seed, simTime) gives the same sample: golden hash', () => {
    // Update deliberately when the simulation changes on purpose (pnpm test prints the new hash).
    expect(sampleHash('harvest-day')).toBe(
      '6ad25b579ee5f9e83546dc154270fa59d443321616a87e633a58021084100347',
    );
  });

  test("1f.2's mixed fleet changed nothing for the M0 machines (their golden hash before 1f.2)", () => {
    expect(sampleHash('harvest-day', 1, 11)).toBe(
      '7c1aea5052ffe6aa2dfe0f0e70b0f71e93c1d0e7a9a9678662f76afcd59bd8ca',
    );
  });

  test('1f.2: the machines no scenario names stay parked in the shop yard, engines off', () => {
    for (const scenario of SCENARIO_NAMES) {
      const w = createDemoWorld({ scenario });
      const yard = w.farm.shop.geofence.coordinates[0] ?? [];
      for (const m of w.farm.machines.slice(11)) {
        const seen = new Set<string>();
        for (let k = 0; k < 48; k++) {
          const s = w.machineAt(m.id, new Date(w.startsAt.getTime() + k * 20 * 60_000));
          expect(s, m.unitNo).not.toBeNull();
          if (!s) continue;
          expect(s.engineOn, `${scenario} ${m.unitNo}`).toBe(false);
          expect(s.speedMph).toBe(0);
          expect(pointInRing([s.lng, s.lat], yard), `${scenario} ${m.unitNo} in the yard`).toBe(
            true,
          );
          seen.add(`${s.lng},${s.lat}`);
        }
        expect(seen.size, `${scenario} ${m.unitNo} parked`).toBe(1);
      }
    }
  });

  test('two fresh worlds agree for every scenario; another seed differs', () => {
    for (const s of SCENARIO_NAMES) expect(sampleHash(s)).toBe(sampleHash(s));
    expect(sampleHash('harvest-day', 2)).not.toBe(sampleHash('harvest-day', 1));
  });

  test('sampling order and cache eviction do not change answers', () => {
    const w = createDemoWorld({ scenario: 'harvest-day' });
    const id = w.farm.machines[0]?.id ?? '';
    const t = local('2026-10-15 12:34');
    const first = w.machineAt(id, t);
    for (let d = 0; d < 6; d++) w.dayPlan(d); // evicts day 0 from the plan cache
    expect(w.machineAt(id, t)).toEqual(first);
    const fresh = createDemoWorld({ scenario: 'harvest-day' });
    expect(fresh.machineAt(id, local('2026-10-18 09:00'))).toEqual(
      w.machineAt(id, local('2026-10-18 09:00')),
    );
  });

  test('the farm depends only on the seed', () => {
    for (const s of SCENARIO_NAMES)
      expect(createSimWorld({ scenario: s }).farm).toEqual(buildSimFarm());
  });
});

describe('machineAt', () => {
  const w = createDemoWorld({ scenario: 'harvest-day' });
  const machines = w.farm.machines;
  const unit = (u: string) => machines.find((m) => m.unitNo === u)?.id ?? '';

  test('is cheap once the day is planned (well under 1 ms)', () => {
    const t0 = w.startsAt.getTime();
    w.machineAt(unit('C1'), w.startsAt); // plan day 0
    const started = performance.now();
    let n = 0;
    for (let k = 0; k < 2000; k++) {
      for (const m of machines) {
        w.machineAt(m.id, new Date(t0 + k * 17_000));
        n++;
      }
    }
    const perCallMs = (performance.now() - started) / n;
    expect(perCallMs).toBeLessThan(0.05);
  });

  test('unknown machines, bad dates -> null; before day 0 and after the horizon -> parked', () => {
    expect(w.machineAt('not-a-machine', w.startsAt)).toBeNull();
    expect(w.machineAt(unit('C1'), new Date(Number.NaN))).toBeNull();
    const before = w.machineAt(unit('S1'), new Date('2026-10-01T12:00:00Z'));
    expect(before).toMatchObject({ speedMph: 0, engineOn: false, activity: 'idle', fieldId: null });
    expect(w.dayIndexAt(new Date('2027-06-01T12:00:00Z'))).toBeGreaterThanOrEqual(HORIZON_DAYS);
    const short = createDemoWorld({ scenario: 'harvest-day', horizonDays: 2 });
    const c1 = short.farm.machines[0]?.id ?? '';
    const lastDay = short.machineAt(c1, local('2026-10-17 04:59'));
    const after = short.machineAt(c1, new Date('2027-06-01T12:00:00Z'));
    expect(after).toMatchObject({
      speedMph: 0,
      engineOn: false,
      lng: lastDay?.lng,
      lat: lastDay?.lat,
    });
    expect(after?.engineHours).toBeGreaterThanOrEqual(lastDay?.engineHours ?? Number.NaN);
    expect(() => short.dayPlan(2)).toThrow(/outside/);
  });

  test('day windows run 05:00 to 05:00 farm time', () => {
    expect(w.dayIndexAt(w.startsAt)).toBe(0);
    expect(w.dayWindow(0).start.toISOString()).toBe('2026-10-15T09:00:00.000Z');
    expect(w.dayWindow(0).end.toISOString()).toBe('2026-10-16T09:00:00.000Z');
    expect(w.dayIndexAt(local('2026-10-16 04:59'))).toBe(0);
    expect(w.dayIndexAt(local('2026-10-16 05:00'))).toBe(1);
    // DST ends Nov 1 2026 at 02:00: the window Oct 31 05:00 -> Nov 1 05:00 is 25 hours long.
    const hours = (d: number) => {
      const win = w.dayWindow(d);
      return (win.end.getTime() - win.start.getTime()) / 3_600_000;
    };
    expect([hours(15), hours(16), hours(17)]).toEqual([24, 25, 24]);
  });

  test('harvest-day at mid-morning: combines working in fields, trucks on the move', () => {
    const t = local('2026-10-15 10:00');
    const s = (u: string) => w.machineAt(unit(u), t) as SimMachineSample;
    for (const u of ['C1', 'C2']) {
      expect(s(u).fieldId).not.toBeNull();
      expect(s(u).engineOn).toBe(true);
    }
    const semis = ['S1', 'S2', 'S3', 'S4'].map(s);
    expect(semis.every((x) => x.engineOn)).toBe(true);
    expect(s('SP1')).toMatchObject({ engineOn: false, speedMph: 0 });
    expect(s('D1')).toMatchObject({ engineOn: false, speedMph: 0 });
    // A combine works at 4-5 mph on a pass.
    let working = 0;
    for (let k = 0; k < 60; k++) {
      const c = w.machineAt(unit('C1'), new Date(t.getTime() + k * 60_000)) as SimMachineSample;
      if (c.activity === 'working' && c.speedMph > 4) {
        working++;
        expect(c.speedMph).toBeLessThan(5);
      }
    }
    expect(working).toBeGreaterThan(30);
    const report = w.dayReport(0);
    expect(report.work.reduce((a, r) => a + r.acres, 0)).toBeGreaterThan(200);
    expect(report.loads.length).toBeGreaterThan(30);
    expect(report.forcedStop).toEqual([]);
  });

  test('engine hours, odometer and fuel move with the work and never go backwards', () => {
    const c1 = unit('C1');
    const a = w.machineAt(c1, local('2026-10-15 06:00')) as SimMachineSample;
    const b = w.machineAt(c1, local('2026-10-15 18:00')) as SimMachineSample;
    expect(b.engineHours - a.engineHours).toBeGreaterThan(9);
    expect(b.engineHours - a.engineHours).toBeLessThan(12.1);
    expect(b.odometerMi).toBeGreaterThan(a.odometerMi);
    expect(b.fuelPct).toBeLessThan(a.fuelPct);
    // Overnight refuel: next morning the tank is full again.
    const next = w.machineAt(c1, local('2026-10-16 05:30')) as SimMachineSample;
    expect(next.fuelPct).toBe(100);
    expect(next.engineHours).toBeGreaterThanOrEqual(b.engineHours);
  });
});

describe('every scenario produces valid samples', () => {
  for (const scenario of SCENARIO_NAMES) {
    test(scenario, () => {
      const w = createDemoWorld({ scenario });
      const fields = new Set(w.farm.fields.map((f) => f.id));
      for (let k = 0; k < 24 * 6; k++) {
        const t = new Date(w.startsAt.getTime() + k * 10 * 60_000);
        for (const m of w.farm.machines) {
          const s = w.machineAt(m.id, t);
          expect(s).not.toBeNull();
          if (!s) continue;
          expect(s.heading >= 0 && s.heading < 360).toBe(true);
          expect(s.speedMph).toBeGreaterThanOrEqual(0);
          expect(s.fuelPct >= 0 && s.fuelPct <= 100).toBe(true);
          expect(ACTIVITIES).toContain(s.activity);
          if (s.fieldId) expect(fields.has(s.fieldId)).toBe(true);
          if (!s.engineOn) expect(s.speedMph).toBe(0);
          expect(s.lng).toBeGreaterThan(-84.45);
          expect(s.lng).toBeLessThan(-83.1);
          expect(s.lat).toBeGreaterThan(41.65);
          expect(s.lat).toBeLessThan(42.15);
        }
      }
    });
  }
});

describe('scenario behaviour', () => {
  const worlds = new Map<ScenarioName, ReturnType<typeof createDemoWorld>>();
  const at = (scenario: ScenarioName, unitNo: string, when: string) => {
    let w = worlds.get(scenario);
    if (!w) {
      w = createDemoWorld({ scenario });
      worlds.set(scenario, w);
    }
    const m = w.farm.machines.find((x) => x.unitNo === unitNo);
    return w.machineAt(m?.id ?? '', local(when)) as SimMachineSample;
  };

  test('winter-idle: everything parked, engines off', () => {
    const w = createDemoWorld({ scenario: 'winter-idle' });
    for (let k = 0; k < 48; k++) {
      const t = new Date(w.startsAt.getTime() + k * 30 * 60_000);
      for (const m of w.farm.machines) {
        expect(w.machineAt(m.id, t)).toMatchObject({ engineOn: false, speedMph: 0, fieldId: null });
      }
    }
  });

  test('bad-morning moves exactly like harvest-day', () => {
    const a = createDemoWorld({ scenario: 'bad-morning' });
    const b = createDemoWorld({ scenario: 'harvest-day' });
    expect(a.startsAt.getTime()).toBeLessThan(b.startsAt.getTime());
    for (let k = 0; k < 40; k++) {
      const t = new Date(a.startsAt.getTime() + k * 23 * 60_000);
      for (const m of a.farm.machines) expect(a.machineAt(m.id, t)).toEqual(b.machineAt(m.id, t));
    }
  });

  test('breakdown: C2 dead in the field from 10:20, C1 still harvesting', () => {
    const before = at('breakdown', 'C2', '2026-10-15 10:00');
    expect(before.engineOn).toBe(true);
    const after = at('breakdown', 'C2', '2026-10-15 13:00');
    expect(after).toMatchObject({ engineOn: false, speedMph: 0 });
    expect(after.fieldId).not.toBeNull();
    expect(at('breakdown', 'C2', '2026-10-16 13:00')).toMatchObject({
      engineOn: false,
      speedMph: 0,
    });
    expect(at('breakdown', 'C1', '2026-10-15 13:00').engineOn).toBe(true);
  });

  test('spray-windy: sprays at dawn, parked in the wind, back at it in the evening', () => {
    expect(at('spray-windy', 'SP1', '2026-06-09 07:30').engineOn).toBe(true);
    expect(at('spray-windy', 'SP1', '2026-06-09 13:00')).toMatchObject({
      engineOn: false,
      speedMph: 0,
    });
    let evening = 0;
    for (let k = 0; k < 120; k += 5) {
      const s = at(
        'spray-windy',
        'SP1',
        `2026-06-09 ${18 + Math.floor((30 + k) / 60)}:${String((30 + k) % 60).padStart(2, '0')}`,
      );
      if (s.activity === 'working') evening++;
    }
    expect(evening).toBeGreaterThan(10);
  });

  test('planting-day: the planter and the sprayer work, the harvest fleet stays home', () => {
    expect(at('planting-day', 'P1', '2026-05-05 10:00').engineOn).toBe(true);
    expect(at('planting-day', 'SP1', '2026-05-05 10:00').engineOn).toBe(true);
    expect(at('planting-day', 'C1', '2026-05-05 10:00')).toMatchObject({ engineOn: false });
    expect(at('planting-day', 'S1', '2026-05-05 10:00')).toMatchObject({ engineOn: false });
  });
});
