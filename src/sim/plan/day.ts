/**
 * One simulated day: the actors a scenario puts to work (harvest crews + trucks, fieldwork
 * machines), every other machine parked, stepped together at DT_S resolution from the first
 * departure until everyone is done. Output: one Track per machine, the state the next day
 * starts from, and a report (work done, loads delivered).
 *
 * Deterministic: no clocks, no Math.random; every random draw comes from rngFor(seed, ...).
 */
import type { Agent, MachineStart } from './agent';
import type { DayContext } from './context';
import type { Track } from './track';

/** Simulation step, seconds. */
export const DT_S = 1;
export const WAIT = -1;

export type Op = 'harvest' | 'plant' | 'spray';

export interface DayWindow {
  /** Day index relative to the scenario's first day (0). */
  index: number;
  /** Civil day number (days since 1970-01-01) of the local date. */
  dayNumber: number;
  /** Epoch ms of the window start (05:00 local) and end (05:00 local next day). */
  start: number;
  end: number;
  /** Epoch ms of a local time on this day. */
  at(minuteOfDay: number): number;
}

export interface WorkRange {
  machineKey: string;
  op: Op;
  field: number;
  widthM: number;
  s0: number;
  s1: number;
  areaM2: number;
  firstAt: number;
  lastAt: number;
}

export interface LoadRecord {
  semiKey: string;
  elevator: number;
  field: number;
  bushels: number;
  arrivedAt: number;
  unloadedAt: number;
}

export interface DayEvent {
  t: number;
  machineKey: string;
  what: string;
}

export interface DayReport {
  work: WorkRange[];
  loads: LoadRecord[];
  events: DayEvent[];
  /** Machines the safety cutoff had to stop (should stay empty). */
  forcedStop: string[];
}

/** What carries over from one day to the next. */
export interface DayState {
  /** By machine index. */
  machines: MachineStart[];
  /** `${op}:${fieldIdx}` -> metres of coverage path done. */
  progress: Record<string, number>;
  /** Machine key -> position in its field list. */
  cursor: Record<string, number>;
  /** Machines broken down (stay down). */
  down: string[];
}

export interface DayResult {
  window: DayWindow;
  tracks: Track[];
  end: DayState;
  report: DayReport;
}

/** Shared by the actors of one day. */
export interface DayEnv {
  ctx: DayContext;
  window: DayWindow;
  seed: number;
  report: DayReport;
  progress: Record<string, number>;
  cursor: Record<string, number>;
  down: Set<string>;
}

export function cloneState(s: DayState): DayState {
  return {
    machines: s.machines.map((m) => ({ ...m })),
    progress: { ...s.progress },
    cursor: { ...s.cursor },
    down: [...s.down],
  };
}

/** Base class: the step loop around a state machine's `handle`. */
export abstract class Actor {
  constructor(
    readonly a: Agent,
    readonly env: DayEnv,
  ) {}

  /** Handle the current state from `now` for up to `rem` seconds: leftover seconds, or WAIT. */
  protected abstract handle(now: number, rem: number): number;

  /** True once the actor is done for the day (parked, down). */
  abstract get final(): boolean;

  /** Called once after the loop (e.g. to close work ranges). */
  finish(_t: number): void {}

  /** Force-stop at the safety cutoff. */
  abstract forceStop(t: number): void;

  step(t: number, dt: number): void {
    let now = t;
    let rem = dt;
    for (let guard = 0; rem > 1e-9 && guard < 16; guard++) {
      const left = this.handle(now, rem);
      if (left === WAIT) break;
      now += (rem - left) * 1000;
      rem = left;
    }
    // Waiting: stop if moving, but don't record a keyframe every step; the next state change
    // (or the end of the day) closes the interval with exact counters.
    if (rem > 1e-9 && this.a.mps !== 0) this.a.set(now, { mps: 0 });
  }

  protected event(t: number, what: string): void {
    this.env.report.events.push({ t, machineKey: this.a.key, what });
  }
}

export function newReport(): DayReport {
  return { work: [], loads: [], events: [], forcedStop: [] };
}
