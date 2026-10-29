/**
 * createSimWorld: the farm plus a scenario's behaviour over sim time (contracts §9).
 *
 * Days are planned lazily and chained: day d starts from where day d-1 ended (positions,
 * counters, field progress, breakdowns), after the overnight refuel. Before day 0 every
 * machine is parked where day 0 starts; after HORIZON_DAYS the season is over and everything
 * stays parked where the last day ended. A planned day costs tens of milliseconds once; a
 * sample is a binary search plus interpolation (microseconds).
 */
import { buildDemoFarm, DEFAULT_SIM_SEED, type DemoFarm } from './farm/build';
import { countersAt } from './farm/fleet';
import { fromGeoRef } from './geo/georef';
import { toLngLatHeading } from './geo/lnglat';
import type { MachineStart } from './plan/agent';
import { buildContext, type DayContext } from './plan/context';
import { workedSegments } from './plan/coverage';
import type { DayReport, DayResult, DayState, DayWindow } from './plan/day';
import { simulateDay } from './plan/simulate';
import type { TrackSample } from './plan/track';
import { rngFor } from './rng';
import { SCENARIOS, type ScenarioDef } from './scenarios';
import { civilDayNumber, localDayTime, localParts } from './time';
import {
  type CreateSimWorldOptions,
  type LngLat,
  SCENARIO_NAMES,
  type ScenarioName,
  type SimMachineSample,
  type SimWorld,
} from './types';

/**
 * Days a scenario runs before the season is over: after that everything stays parked where the
 * last day ended. Bounds the work a far clock jump costs (days are planned in order, ~0.1 s each).
 */
export const HORIZON_DAYS = 30;
/** Days start (and machines refuel) at 05:00 local. */
export const DAY_START_MINUTE = 5 * 60;
const PLAN_CACHE = 4;
const SQ_M_PER_ACRE = 4046.86;

export interface SimWorkReport {
  machineId: string;
  unitNo: string;
  op: 'harvest' | 'plant' | 'spray';
  fieldId: string;
  fieldName: string;
  acres: number;
  firstAt: string;
  lastAt: string;
  /** Worked pass centrelines, [lng, lat] pairs (checks, plots). */
  passes: [LngLat, LngLat][];
  widthM: number;
}

export interface SimLoadReport {
  semiId: string;
  unitNo: string;
  elevatorId: string;
  elevatorName: string;
  fieldId: string | null;
  bushels: number;
  arrivedAt: string;
  unloadedAt: string;
}

export interface SimDayReport {
  dayIndex: number;
  start: string;
  end: string;
  work: SimWorkReport[];
  loads: SimLoadReport[];
  events: { at: string; machineId: string; what: string }[];
  forcedStop: string[];
}

export interface DemoWorldOptions extends CreateSimWorldOptions {
  /** Override HORIZON_DAYS (tests). */
  horizonDays?: number;
}

/** The world plus what scripts and checks use (still a SimWorld). */
export interface DemoWorld extends SimWorld {
  readonly farm: DemoFarm;
  readonly context: DayContext;
  /** Day index (0 = the scenario's first day) of a sim instant; days run 05:00-05:00 local. */
  dayIndexAt(simTime: Date): number;
  dayWindow(index: number): { start: Date; end: Date };
  dayReport(index: number): SimDayReport;
  /** Internal planner output for a day (checks). */
  dayPlan(index: number): DayResult;
}

function refuelOvernight(ctx: DayContext, s: DayState): DayState {
  return {
    ...s,
    machines: s.machines.map((m, i) => {
      const role = ctx.machines[i]?.spec.role;
      const topOff = role === 'semi' ? m.fuelPct < 50 : true;
      return topOff ? { ...m, fuelPct: 100 } : { ...m };
    }),
  };
}

class World implements DemoWorld {
  readonly scenario: ScenarioName;
  readonly seed: number;
  readonly farm: DemoFarm;
  readonly context: DayContext;
  readonly startsAt: Date;
  private readonly def: ScenarioDef;
  private readonly epochDay: number;
  private readonly initial: DayState;
  /** ends[d] = state at the end of day d. */
  private readonly ends: DayState[] = [];
  private readonly plans = new Map<number, DayResult>();
  private readonly horizon: number;

  constructor(opts: DemoWorldOptions) {
    if (!SCENARIO_NAMES.includes(opts.scenario)) {
      throw new RangeError(`unknown scenario '${String(opts.scenario)}'`);
    }
    this.scenario = opts.scenario;
    this.seed = opts.seed ?? DEFAULT_SIM_SEED;
    this.def = SCENARIOS[opts.scenario];
    this.farm = buildDemoFarm(this.seed);
    this.context = buildContext(this.farm);
    this.startsAt = new Date(this.def.startsAt);
    this.epochDay = civilDayNumber(this.def.epoch.y, this.def.epoch.m, this.def.epoch.d);
    this.initial = this.initialState();
    this.horizon = Math.max(1, Math.floor(opts.horizonDays ?? HORIZON_DAYS));
  }

  private initialState(): DayState {
    const t0 = this.window(0).start;
    const ctx = this.context;
    return {
      machines: ctx.machines.map((mi): MachineStart => {
        const slot = ctx.shop.slot(mi.idx);
        const c = countersAt(mi.spec, t0);
        const fuel =
          mi.spec.role === 'semi' ? rngFor(this.seed, 'fuel', mi.machine.key).range(55, 95) : 100;
        return {
          x: slot.x,
          y: slot.y,
          hdg: ctx.shop.parkHeading,
          engineHours: c.engineHours,
          odometerMi: c.odometerMi,
          fuelPct: fuel,
          load: 0,
          field: -1,
        };
      }),
      progress: {},
      cursor: {},
      down: [],
    };
  }

  private window(index: number): DayWindow {
    const dayNumber = this.epochDay + index;
    return {
      index,
      dayNumber,
      start: localDayTime(dayNumber, DAY_START_MINUTE),
      end: localDayTime(dayNumber + 1, DAY_START_MINUTE),
      at: (minuteOfDay: number) => localDayTime(dayNumber, minuteOfDay),
    };
  }

  dayIndexAt(simTime: Date): number {
    const lp = localParts(simTime.getTime());
    const day = civilDayNumber(lp.y, lp.m, lp.d) - (lp.minuteOfDay < DAY_START_MINUTE ? 1 : 0);
    return day - this.epochDay;
  }

  dayWindow(index: number): { start: Date; end: Date } {
    const w = this.window(index);
    return { start: new Date(w.start), end: new Date(w.end) };
  }

  private startOf(index: number): DayState {
    if (index === 0) return this.initial;
    const prev = this.ends[index - 1];
    if (!prev) throw new Error(`day ${index - 1} not planned`);
    return refuelOvernight(this.context, prev);
  }

  dayPlan(index: number): DayResult {
    if (!Number.isInteger(index) || index < 0 || index >= this.horizon) {
      throw new RangeError(`day ${index} is outside 0..${this.horizon - 1}`);
    }
    const hit = this.plans.get(index);
    if (hit) {
      // Refresh LRU position.
      this.plans.delete(index);
      this.plans.set(index, hit);
      return hit;
    }
    let result: DayResult | null = null;
    // Plan every day up to `index` whose end state is unknown (the chain), then `index` itself.
    for (let d = Math.min(this.ends.length, index); d <= index; d++) {
      const w = this.window(d);
      const r = simulateDay(
        this.context,
        w,
        this.def.dayConfig(this.context, w, this.seed),
        this.startOf(d),
        this.seed,
      );
      this.ends[d] = r.end;
      if (d === index) result = r;
    }
    const out = result as DayResult;
    this.plans.set(index, out);
    while (this.plans.size > PLAN_CACHE) {
      const oldest = this.plans.keys().next().value as number;
      this.plans.delete(oldest);
    }
    return out;
  }

  machineAt(machineId: string, simTime: Date): SimMachineSample | null {
    const idx = this.context.machineIndex.get(machineId);
    const t = simTime.getTime();
    if (idx === undefined || !Number.isFinite(t)) return null;
    const d = this.dayIndexAt(simTime);
    if (d < 0) return this.parked(idx, this.initial);
    if (d >= this.horizon) {
      const last = this.horizon - 1;
      if (!this.ends[last]) this.dayPlan(last);
      return this.parked(idx, this.ends[last] as DayState);
    }
    const track = this.dayPlan(d).tracks[idx];
    return track ? this.toSample(track.sample(t)) : null;
  }

  private parked(idx: number, state: DayState): SimMachineSample | null {
    const m = state.machines[idx];
    if (!m) return null;
    return this.toSample({
      x: m.x,
      y: m.y,
      hdg: m.hdg,
      speedMph: 0,
      act: 'idle',
      engineOn: false,
      field: m.field,
      engineHours: m.engineHours,
      odometerMi: m.odometerMi,
      fuelPct: m.fuelPct,
    });
  }

  private toSample(s: TrackSample): SimMachineSample {
    const { lngLat, heading } = toLngLatHeading({ x: s.x, y: s.y }, s.hdg);
    const h = Math.round(heading * 10) / 10;
    const speed = Math.round(s.speedMph * 100) / 100;
    return {
      lng: Math.round(lngLat[0] * 1e7) / 1e7,
      lat: Math.round(lngLat[1] * 1e7) / 1e7,
      heading: h >= 360 ? 0 : h,
      speedMph: Math.max(speed, 0),
      activity: s.act,
      engineOn: s.engineOn,
      engineHours: Math.round(s.engineHours * 1000) / 1000,
      odometerMi: Math.round(s.odometerMi * 1000) / 1000,
      fuelPct: Math.max(0, Math.min(100, Math.round(s.fuelPct * 10) / 10)),
      fieldId: s.field >= 0 ? (this.farm.fields[s.field]?.id ?? null) : null,
    };
  }

  dayReport(index: number): SimDayReport {
    const plan = this.dayPlan(index);
    return publicReport(this.context, plan.report, plan.window);
  }
}

function publicReport(ctx: DayContext, r: DayReport, w: DayWindow): SimDayReport {
  const iso = (t: number) => new Date(t).toISOString();
  const machine = (key: string) => ctx.machines.find((m) => m.machine.key === key)?.machine;
  return {
    dayIndex: w.index,
    start: iso(w.start),
    end: iso(w.end),
    work: r.work
      .filter((wr) => wr.areaM2 > 0)
      .map((wr) => {
        const m = machine(wr.machineKey);
        const f = ctx.fields[wr.field];
        const cov = f?.coverage(wr.widthM);
        return {
          machineId: m?.id ?? wr.machineKey,
          unitNo: m?.unitNo ?? wr.machineKey,
          op: wr.op,
          fieldId: f?.field.id ?? '',
          fieldName: f?.field.name ?? '',
          acres: Math.round((wr.areaM2 / SQ_M_PER_ACRE) * 100) / 100,
          firstAt: iso(wr.firstAt),
          lastAt: iso(wr.lastAt),
          widthM: wr.widthM,
          passes: cov
            ? workedSegments(cov, wr.s0, wr.s1).map(
                ([a, b]) => [fromGeoRef(a.x, a.y), fromGeoRef(b.x, b.y)] as [LngLat, LngLat],
              )
            : [],
        };
      }),
    loads: r.loads.map((l) => {
      const m = machine(l.semiKey);
      const e = ctx.elevators[l.elevator]?.elevator;
      return {
        semiId: m?.id ?? l.semiKey,
        unitNo: m?.unitNo ?? l.semiKey,
        elevatorId: e?.id ?? '',
        elevatorName: e?.name ?? '',
        fieldId: l.field >= 0 ? (ctx.fields[l.field]?.field.id ?? null) : null,
        bushels: l.bushels,
        arrivedAt: iso(l.arrivedAt),
        unloadedAt: iso(l.unloadedAt),
      };
    }),
    events: r.events.map((e) => ({
      at: iso(e.t),
      machineId: machine(e.machineKey)?.id ?? e.machineKey,
      what: e.what,
    })),
    forcedStop: r.forcedStop,
  };
}

/** createSimWorld with the extras scripts and checks use. */
export function createDemoWorld(opts: DemoWorldOptions): DemoWorld {
  return new World(opts);
}
