/**
 * Run a scenario headless and check what the board would see (plan §7 "Scenarios":
 * `pnpm sim:scenario <name> --speed 60 --assert`).
 *
 * The world is sampled every `fineStepS` sim seconds for the geometric checks (machines in
 * transport stay on the road graph or inside a field / yard, work happens inside the field,
 * counters only go up, speeds are plausible), and every `poll x speed` sim seconds for the
 * "board view" summary (how far a marker jumps between two polls at that speed). Outcomes
 * (acres worked, loads delivered) come from the day report and are cross-checked against the
 * samples.
 */
import { ACTIVITIES, type MachineKind } from '../domain/fleet';
import { toGeoRef } from './geo/georef';
import { localDistance } from './geo/lnglat';
import { distToSegment, pointInPolygon, signedDistanceToRing, type Vec } from './geo/vec';
import { BREAKDOWN, SPRAY_WINDY_HOLD } from './scenarios';
import { hhmm, localParts } from './time';
import type { ScenarioName, SimMachineSample } from './types';
import type { DemoWorld, SimDayReport } from './world';
import { createDemoWorld } from './world';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MachineSummary {
  unitNo: string;
  kind: MachineKind;
  miles: number;
  engineHours: number;
  workingHours: number;
  maxSpeedMph: number;
  fuelUsedPct: number;
}

export interface ScenarioRun {
  scenario: ScenarioName;
  seed: number;
  startsAt: string;
  days: { index: number; start: string; end: string }[];
  speed: number;
  pollSeconds: number;
  summary: {
    acres: Record<string, number>;
    loads: number;
    bushels: number;
    loadsByElevator: Record<string, number>;
    acresByField: Record<string, number>;
    machines: MachineSummary[];
    board: { pollSimSeconds: number; samples: number; maxJumpM: number; maxJumpUnit: string };
  };
  reports: SimDayReport[];
  checks: CheckResult[];
  ok: boolean;
}

export interface RunOptions {
  scenario: ScenarioName;
  seed?: number;
  /** Days to run from day 0 (default 1). */
  days?: number;
  /** Sim speed the board would run at (default 60). */
  speed?: number;
  /** Seconds between two board polls (default 5, the local demo cadence). */
  pollSeconds?: number;
  /** Sim seconds between samples for the geometric checks (default 5). */
  fineStepS?: number;
  /** Reuse a world (tests). */
  world?: DemoWorld;
}

/** Bounding box of the offline basemap (contracts §10): everything must stay inside. */
const AOI = { west: -84.45, south: 41.65, east: -83.1, north: 42.15 };
/** Off-road tolerance: road right-of-way plus the truck shoulder and driveways. */
const ROAD_TOLERANCE_M = 20;
const FIELD_TOLERANCE_M = 0.5;
const MAX_SPEED_MPH: Record<MachineKind, number> = {
  combine: 20.5,
  tractor: 25,
  sprayer: 30.5,
  planter: 16,
  grain_cart: 22,
  semi: 55.5,
  trailer: 55.5,
  drone: 25,
  pickup: 65,
};

class RoadIndex {
  private readonly cells = new Map<string, [Vec, Vec][]>();
  private static readonly CELL = 800;

  constructor(world: DemoWorld) {
    const nodes = new Map(
      world.farm.roads.nodes.map((n) => [n.id, toGeoRef(n.lngLat[0], n.lngLat[1])]),
    );
    for (const e of world.farm.roads.edges) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / RoadIndex.CELL));
      for (let k = 0; k <= steps; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
        const key = this.key(p);
        const list = this.cells.get(key) ?? [];
        if (!list.some(([x, y]) => x === a && y === b)) list.push([a, b]);
        this.cells.set(key, list);
      }
    }
  }

  private key(p: Vec, di = 0, dj = 0): string {
    return `${Math.floor(p.x / RoadIndex.CELL) + di}:${Math.floor(p.y / RoadIndex.CELL) + dj}`;
  }

  distance(p: Vec): number {
    let best = Number.POSITIVE_INFINITY;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [a, b] of this.cells.get(this.key(p, di, dj)) ?? []) {
          best = Math.min(best, distToSegment(p, a, b));
        }
      }
    }
    return best;
  }
}

const ringOf = (coords: readonly (readonly number[])[]): Vec[] => {
  const pts = coords.map((c) => toGeoRef(c[0] as number, c[1] as number));
  pts.pop();
  return pts;
};

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function runScenario(opts: RunOptions): ScenarioRun {
  const world = opts.world ?? createDemoWorld({ scenario: opts.scenario, seed: opts.seed });
  const days = Math.max(1, Math.floor(opts.days ?? 1));
  const speed = opts.speed ?? 60;
  const pollSeconds = opts.pollSeconds ?? 5;
  const fine = Math.max(1, opts.fineStepS ?? 5);
  const farm = world.farm;
  const fieldRings = new Map(
    farm.fields.map((f) => [f.id, ringOf(f.boundary.coordinates[0]?.[0] ?? [])]),
  );
  const yards = [
    ...farm.elevators.map((e) => ({
      kind: 'elevator',
      id: e.id,
      ring: ringOf(e.geofence.coordinates[0] ?? []),
    })),
    { kind: 'shop', id: farm.shop.id, ring: ringOf(farm.shop.geofence.coordinates[0] ?? []) },
    ...farm.binSites.map((b) => ({
      kind: 'bins',
      id: b.id,
      ring: ringOf(b.geofence.coordinates[0] ?? []),
    })),
  ];
  const roads = new RoadIndex(world);
  const checks: CheckResult[] = [];
  const problems = new Map<string, string[]>();
  const fail = (check: string, msg: string) => {
    const list = problems.get(check) ?? [];
    if (list.length < 5) list.push(msg);
    problems.set(check, list);
  };
  const counts = new Map<string, number>();
  const bump = (check: string) => counts.set(check, (counts.get(check) ?? 0) + 1);

  const reports: SimDayReport[] = [];
  const windows: { index: number; start: string; end: string }[] = [];
  const perMachine = farm.machines.map((m) => ({
    m,
    first: null as SimMachineSample | null,
    last: null as SimMachineSample | null,
    workingS: 0,
    maxSpeed: 0,
  }));
  let boardSamples = 0;
  let maxJump = 0;
  let maxJumpUnit = '';
  const boardStepMs = pollSeconds * speed * 1000;
  const iso = (t: number) => new Date(t).toISOString();

  for (let d = 0; d < days; d++) {
    const w = world.dayWindow(d);
    windows.push({ index: d, start: w.start.toISOString(), end: w.end.toISOString() });
    const report = world.dayReport(d);
    reports.push(report);
    const t0 = w.start.getTime();
    const t1 = w.end.getTime();
    for (const pm of perMachine) {
      const { m } = pm;
      const kind = m.kind;
      let prev: SimMachineSample | null = null;
      for (let t = t0; t < t1; t += fine * 1000) {
        const s = world.machineAt(m.id, new Date(t));
        if (!s) {
          fail('samples are valid', `${m.unitNo} has no sample at ${iso(t)}`);
          continue;
        }
        pm.first ??= s;
        pm.last = s;
        bump('samples are valid');
        const where = `${m.unitNo} ${iso(t)}`;
        if (
          !(s.heading >= 0 && s.heading < 360) ||
          !(s.speedMph >= 0) ||
          !(s.fuelPct >= 0 && s.fuelPct <= 100) ||
          !ACTIVITIES.includes(s.activity) ||
          !(s.lng > AOI.west && s.lng < AOI.east && s.lat > AOI.south && s.lat < AOI.north) ||
          (s.fieldId !== null && !fieldRings.has(s.fieldId))
        ) {
          fail('samples are valid', `${where}: ${JSON.stringify(s)}`);
        }
        if (!s.engineOn && s.speedMph > 0)
          fail('engine off means stopped', `${where} ${s.speedMph} mph`);
        bump('engine off means stopped');
        if (s.speedMph > MAX_SPEED_MPH[kind])
          fail('speeds are plausible', `${where} ${s.speedMph} mph`);
        bump('speeds are plausible');
        pm.maxSpeed = Math.max(pm.maxSpeed, s.speedMph);
        if (prev) {
          if (s.engineHours + 1e-9 < prev.engineHours || s.odometerMi + 1e-9 < prev.odometerMi) {
            fail('counters never go down', `${where} hours ${prev.engineHours}->${s.engineHours}`);
          }
          bump('counters never go down');
          if (prev.activity === 'working') pm.workingS += fine;
        }
        prev = s;
        const p = toGeoRef(s.lng, s.lat);
        if (s.fieldId) {
          const ring = fieldRings.get(s.fieldId) as Vec[];
          if (signedDistanceToRing(p, ring) > FIELD_TOLERANCE_M) {
            fail('a machine in a field is inside it', `${where} is outside field ${s.fieldId}`);
          }
          bump('a machine in a field is inside it');
        }
        if (s.activity === 'working' && kind !== 'semi') {
          if (!s.fieldId) fail('work happens inside a field', `${where} working outside any field`);
          bump('work happens inside a field');
        }
        if (s.activity === 'transport' && !s.fieldId) {
          const onRoad = roads.distance(p) <= ROAD_TOLERANCE_M;
          const inYard = yards.some((y) => signedDistanceToRing(p, y.ring) <= 1);
          if (!onRoad && !inYard) {
            fail(
              'transport stays on the road graph',
              `${where} is ${round(roads.distance(p), 1)} m off the road`,
            );
          }
          bump('transport stays on the road graph');
        }
        if (
          s.activity === 'queued' &&
          !yards.some((y) => y.kind === 'elevator' && pointInPolygon(p, y.ring))
        ) {
          fail('queued trucks are inside an elevator yard', where);
        }
        if (s.activity === 'queued') bump('queued trucks are inside an elevator yard');
      }
      // Board view at the requested speed / poll.
      let last: SimMachineSample | null = null;
      for (let t = t0; t < t1; t += boardStepMs) {
        const s = world.machineAt(m.id, new Date(t));
        if (!s) continue;
        boardSamples++;
        if (last) {
          const jump = localDistance([last.lng, last.lat], [s.lng, s.lat]);
          if (jump > maxJump) {
            maxJump = jump;
            maxJumpUnit = m.unitNo;
          }
        }
        last = s;
      }
      const night = world.machineAt(m.id, new Date(t1 - 60_000));
      if (night && (night.engineOn || night.speedMph > 0)) {
        fail('everything is parked at night', `${m.unitNo} at ${iso(t1 - 60_000)}`);
      }
      bump('everything is parked at night');
    }

    // Plan-level: every worked pass (and its swath edges) lies inside its field.
    for (const wr of report.work) {
      const ring = fieldRings.get(wr.fieldId);
      if (!ring) continue;
      for (const [a, b] of wr.passes) {
        const pa = toGeoRef(a[0], a[1]);
        const pb = toGeoRef(b[0], b[1]);
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
        const n = { x: -(pb.y - pa.y) / len, y: (pb.x - pa.x) / len };
        const h = wr.widthM / 2;
        for (const q of [pa, pb]) {
          for (const k of [-h, 0, h]) {
            const c = { x: q.x + n.x * k, y: q.y + n.y * k };
            if (signedDistanceToRing(c, ring) > FIELD_TOLERANCE_M) {
              fail(
                'no pass outside its field',
                `${wr.unitNo} pass in ${wr.fieldName} leaves the field`,
              );
            }
          }
        }
        bump('no pass outside its field');
      }
    }
    if (report.forcedStop.length) {
      fail('nobody needed a forced stop', `day ${d}: ${report.forcedStop.join(', ')}`);
    }
    bump('nobody needed a forced stop');
  }

  // Outcomes.
  const acres: Record<string, number> = {};
  const acresByField: Record<string, number> = {};
  for (const r of reports) {
    for (const wr of r.work) {
      acres[wr.op] = round((acres[wr.op] ?? 0) + wr.acres);
      acresByField[wr.fieldName] = round((acresByField[wr.fieldName] ?? 0) + wr.acres);
    }
  }
  const loads = reports.flatMap((r) => r.loads);
  const loadsByElevator: Record<string, number> = {};
  for (const l of loads)
    loadsByElevator[l.elevatorName] = (loadsByElevator[l.elevatorName] ?? 0) + 1;
  const bushels = round(
    loads.reduce((s, l) => s + l.bushels, 0),
    0,
  );
  for (const l of loads) {
    if (!(l.bushels > 0 && l.bushels <= 1000.5)) {
      fail('loads fit the truck', `${l.unitNo} ${l.bushels} bu`);
    }
    bump('loads fit the truck');
  }
  if (loads.length) {
    const sorted = loads.map((l) => l.bushels).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    if (median < 900) fail('trucks leave full', `median load ${median} bu`);
    bump('trucks leave full');
  }

  // Scenario expectations.
  const expect = (name: string, ok: boolean, detail: string) => {
    if (!ok) fail(name, detail);
    bump(name);
  };
  const day0 = world.dayWindow(0);
  const at = (local: string) => {
    const lp = localParts(day0.start.getTime());
    const mins = hhmm(local);
    // day0.start is 05:00 local on the scenario's first day.
    return day0.start.getTime() + (mins - lp.minuteOfDay) * 60_000;
  };
  const unit = (u: string) => perMachine.find((p) => p.m.unitNo === u);
  const harvestAcres = acres.harvest ?? 0;
  switch (world.scenario) {
    case 'harvest-day':
    case 'bad-morning': {
      expect(
        'acres harvested',
        harvestAcres >= 200 * days && harvestAcres <= 520 * days,
        `${harvestAcres} ac`,
      );
      expect('loads delivered', loads.length >= 30 * days, `${loads.length} loads`);
      for (const u of ['C1', 'C2']) {
        const h = (unit(u)?.workingS ?? 0) / 3600;
        expect('combines work most of the day', h >= 6 * days, `${u} worked ${round(h, 1)} h`);
      }
      for (const u of ['S1', 'S2', 'S3', 'S4']) {
        const n = loads.filter((l) => l.unitNo === u).length;
        expect('every truck hauls', n >= 5 * days, `${u} hauled ${n} loads`);
      }
      if (world.scenario === 'bad-morning') {
        const twin = createDemoWorld({ scenario: 'harvest-day', seed: world.seed });
        let same = true;
        for (let k = 0; k < 120 && same; k++) {
          const t = new Date(day0.start.getTime() + k * 731_000);
          for (const m of farm.machines) {
            if (
              JSON.stringify(world.machineAt(m.id, t)) !== JSON.stringify(twin.machineAt(m.id, t))
            ) {
              same = false;
              fail(
                'bad-morning moves exactly like harvest-day',
                `${m.unitNo} at ${t.toISOString()}`,
              );
              break;
            }
          }
        }
        bump('bad-morning moves exactly like harvest-day');
      }
      break;
    }
    case 'breakdown': {
      const broke = at(BREAKDOWN.at);
      const c2 = farm.machines.find((m) => m.key === BREAKDOWN.machineKey);
      let still: SimMachineSample | null = null;
      for (let t = broke + 60_000; t < day0.end.getTime(); t += 60_000) {
        const s = c2 ? world.machineAt(c2.id, new Date(t)) : null;
        if (!s) continue;
        still ??= s;
        if (s.engineOn || s.speedMph > 0 || s.lng !== still.lng || s.lat !== still.lat) {
          fail('the broken combine stays put', `${c2?.unitNo} moved at ${iso(t)}`);
          break;
        }
      }
      bump('the broken combine stays put');
      const c1Acres =
        reports[0]?.work.filter((w) => w.unitNo === 'C1').reduce((s, w) => s + w.acres, 0) ?? 0;
      expect('the other combine keeps going', c1Acres >= 150, `C1 harvested ${round(c1Acres)} ac`);
      expect('loads delivered', loads.length >= 20 * days, `${loads.length} loads`);
      break;
    }
    case 'winter-idle': {
      const shop = yards.find((y) => y.kind === 'shop');
      for (const pm of perMachine) {
        for (const s of [pm.first, pm.last]) {
          if (!s) continue;
          const inShop = shop ? pointInPolygon(toGeoRef(s.lng, s.lat), shop.ring) : false;
          expect('everything is parked at the shop', inShop && !s.engineOn, `${pm.m.unitNo}`);
        }
        expect(
          'nothing moves in winter',
          pm.maxSpeed === 0,
          `${pm.m.unitNo} reached ${pm.maxSpeed} mph`,
        );
      }
      break;
    }
    case 'planting-day':
      expect('acres planted', (acres.plant ?? 0) >= 200 * days, `${acres.plant ?? 0} ac`);
      expect('acres sprayed', (acres.spray ?? 0) >= 300 * days, `${acres.spray ?? 0} ac`);
      break;
    case 'spray-windy': {
      const from = at(SPRAY_WINDY_HOLD.from);
      const to = at(SPRAY_WINDY_HOLD.to);
      const sp = farm.machines.find((m) => m.kind === 'sprayer');
      // The sprayer may finish the pass it is on when the wind comes up, then parks.
      for (let t = from + 10 * 60_000; t < to; t += 60_000) {
        const s = sp ? world.machineAt(sp.id, new Date(t)) : null;
        if (s?.activity === 'working') {
          fail('no spraying in the wind', `${sp?.unitNo} ${s?.activity} at ${iso(t)}`);
          break;
        }
      }
      bump('no spraying in the wind');
      const work0 = reports[0]?.work ?? [];
      const before = work0
        .filter((w) => Date.parse(w.lastAt) <= from + 10 * 60_000)
        .reduce((s, w) => s + w.acres, 0);
      const after = work0
        .filter((w) => Date.parse(w.firstAt) >= to)
        .reduce((s, w) => s + w.acres, 0);
      expect(
        'sprays before the wind',
        before >= 150,
        `${round(before)} ac before ${SPRAY_WINDY_HOLD.from}`,
      );
      expect(
        'sprays after the wind',
        after >= 100,
        `${round(after)} ac after ${SPRAY_WINDY_HOLD.to}`,
      );
      break;
    }
  }

  for (const [name, n] of counts) {
    const list = problems.get(name);
    checks.push({
      name,
      ok: !list,
      detail: list ? list.join('; ') : `${n} checked`,
    });
  }
  for (const [name, list] of problems) {
    if (!counts.has(name)) checks.push({ name, ok: false, detail: list.join('; ') });
  }

  const machines: MachineSummary[] = perMachine.map((pm) => ({
    unitNo: pm.m.unitNo,
    kind: pm.m.kind,
    miles: round((pm.last?.odometerMi ?? 0) - (pm.first?.odometerMi ?? 0), 1),
    engineHours: round((pm.last?.engineHours ?? 0) - (pm.first?.engineHours ?? 0), 2),
    workingHours: round(pm.workingS / 3600, 2),
    maxSpeedMph: round(pm.maxSpeed, 1),
    fuelUsedPct: round(Math.max(0, (pm.first?.fuelPct ?? 0) - (pm.last?.fuelPct ?? 0)), 1),
  }));

  return {
    scenario: world.scenario,
    seed: world.seed,
    startsAt: world.startsAt.toISOString(),
    days: windows,
    speed,
    pollSeconds,
    summary: {
      acres,
      loads: loads.length,
      bushels,
      loadsByElevator,
      acresByField,
      machines,
      board: {
        pollSimSeconds: pollSeconds * speed,
        samples: boardSamples,
        maxJumpM: round(maxJump, 0),
        maxJumpUnit,
      },
    },
    reports,
    checks,
    ok: checks.every((c) => c.ok),
  };
}
