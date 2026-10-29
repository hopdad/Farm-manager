/**
 * Run one day: build the actors the scenario asks for, park everything else, step them all
 * together, and freeze one Track per machine (every track spans the whole day window).
 */
import { rngFor } from '../rng';
import { MS } from '../time';
import { Agent } from './agent';
import type { DayContext } from './context';
import {
  type Actor,
  cloneState,
  type DayEnv,
  type DayResult,
  type DayState,
  type DayWindow,
  DT_S,
  newReport,
} from './day';
import { FieldworkActor, type FieldworkParams } from './fieldwork';
import {
  CartActor,
  CombineActor,
  type Crew,
  HarvestDay,
  type HarvestParams,
  SemiActor,
  WARMUP_MS,
} from './harvest';

export interface DayConfig {
  harvest?: HarvestParams;
  fieldwork?: FieldworkParams[];
}

/** Everyone not done this long before the window ends is stopped where they are. */
const SAFETY_CUTOFF_MS = 3 * MS.HOUR;

export function simulateDay(
  ctx: DayContext,
  window: DayWindow,
  config: DayConfig,
  startState: DayState,
  seed: number,
): DayResult {
  const start = cloneState(startState);
  const env: DayEnv = {
    ctx,
    window,
    seed,
    report: newReport(),
    progress: start.progress,
    cursor: start.cursor,
    down: new Set(start.down),
  };
  const agents = ctx.machines.map((mi) => {
    const s = start.machines[mi.idx];
    if (!s) throw new Error(`no start state for ${mi.machine.key}`);
    return new Agent(mi, s, window.start);
  });
  const agentFor = (key: string): Agent => {
    const idx = ctx.machines.findIndex((m) => m.machine.key === key);
    const a = agents[idx];
    if (!a) throw new Error(`no machine ${key}`);
    return a;
  };

  const actors: Actor[] = [];
  const departures: number[] = [];
  let harvest: HarvestDay | null = null;
  if (config.harvest) {
    const hp = config.harvest;
    const day = new HarvestDay(env, hp, (idx) => rngFor(seed, 'elevator-queue', window.index, idx));
    harvest = day;
    hp.crews.forEach((cd, i) => {
      if (!cd.fields.length) return;
      const combine = new CombineActor(agentFor(cd.combineKey), env, day);
      const cart = new CartActor(agentFor(cd.cartKey), env, day);
      const cursor = env.cursor[cd.combineKey] ?? 0;
      const crew: Crew = {
        idx: i,
        combine,
        cart,
        fields: cd.fields,
        workField: cd.fields[cursor % cd.fields.length] as number,
      };
      combine.crew = crew;
      cart.crew = crew;
      day.crews.push(crew);
      actors.push(combine, cart);
    });
    hp.semiKeys.forEach((k, i) => {
      const departAt = hp.semiDepartAt[i] ?? hp.combineDepartAt;
      const semi = new SemiActor(agentFor(k), env, day, departAt);
      day.semis.push(semi);
      actors.push(semi);
      departures.push(departAt);
    });
    departures.push(hp.combineDepartAt, hp.cartDepartAt);
  }
  for (const fw of config.fieldwork ?? []) {
    actors.push(new FieldworkActor(agentFor(fw.machineKey), env, fw));
    departures.push(fw.departAt);
  }

  let t = window.start;
  if (actors.length) {
    const first = Math.min(...departures) - WARMUP_MS - MS.MIN;
    const stepMs = DT_S * 1000;
    // Align steps to whole seconds from the window start (deterministic step grid).
    t = window.start + Math.max(0, Math.ceil((first - window.start) / stepMs)) * stepMs;
    const cutoff = window.end - SAFETY_CUTOFF_MS;
    for (; t < window.end; t += stepMs) {
      if (t >= cutoff) {
        for (const a of actors) a.forceStop(t);
        break;
      }
      if (harvest) for (const e of harvest.elevators) e.step(t);
      for (const a of actors) a.step(t, DT_S);
      if (actors.every((a) => a.final)) {
        t += stepMs;
        break;
      }
    }
  }
  for (const a of actors) a.finish(t);

  for (const a of agents) {
    a.set(a.lastTime, { mps: 0 });
    a.mark(window.end);
  }
  return {
    window,
    tracks: agents.map((a) => a.rec.freeze()),
    end: {
      machines: agents.map((a) => ({
        x: a.pos.x,
        y: a.pos.y,
        hdg: a.hdg,
        engineHours: a.engineHours,
        odometerMi: a.odometerMi,
        fuelPct: a.fuelPct,
        load: a.load,
        field: a.field,
      })),
      progress: env.progress,
      cursor: env.cursor,
      down: [...env.down].sort(),
    },
    report: env.report,
  };
}
