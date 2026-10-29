/**
 * A simulated machine during a planned day: position (EPSG:3078), what it is doing, and its
 * counters (engine hours, odometer, fuel), recorded into a TrackRecorder as it moves.
 *
 * Counters integrate over the interval since the previous record with the state held during
 * that interval, so they are exact and linear between keyframes. Movement primitives (`drive`
 * along a multi-leg trip, `pursue` a moving target, `follow` another machine, `stay`) record
 * every path vertex and state change at its exact time.
 */
import { ACTIVITIES, type Activity } from '../../domain/fleet';
import { MILE_M, MPH_TO_MPS } from '../geo/lnglat';
import { dist, headingOf, type Path, sub, type Vec } from '../geo/vec';
import type { MachineInfo } from './context';
import { TrackRecorder } from './track';

const ACT_CODES = Object.fromEntries(ACTIVITIES.map((a, i) => [a, i])) as Record<Activity, number>;

export interface Leg {
  path: Path;
  /** Metres per second (> 0). */
  mps: number;
  act: Activity;
  /** Field index while on this leg, -1 for none. */
  field: number;
}

export class Trip {
  li = 0;
  s = 0;
  constructor(readonly legs: Leg[]) {}

  get done(): boolean {
    return this.li >= this.legs.length;
  }

  get end(): Vec {
    const last = this.legs[this.legs.length - 1];
    if (!last) throw new Error('empty trip');
    return last.path.end;
  }

  get lengthM(): number {
    return this.legs.reduce((s, l) => s + l.path.length, 0);
  }
}

export const mph = (v: number) => v * MPH_TO_MPS;

/** Where a machine stands when a day begins (also what the previous day ended with). */
export interface MachineStart {
  x: number;
  y: number;
  hdg: number;
  engineHours: number;
  odometerMi: number;
  fuelPct: number;
  /** Bushels on board (combine tank, cart, truck). */
  load: number;
  /** Field index the machine is in (-1 = shop/road). */
  field: number;
}

export class Agent {
  readonly rec = new TrackRecorder();
  pos: Vec;
  hdg: number;
  mps = 0;
  act: Activity = 'idle';
  engineOn = false;
  field: number;
  engineHours: number;
  odometerMi: number;
  fuelPct: number;
  load: number;
  private lastT: number;
  private lastPos: Vec;

  constructor(
    readonly info: MachineInfo,
    start: MachineStart,
    t0: number,
  ) {
    this.pos = { x: start.x, y: start.y };
    this.hdg = start.hdg;
    this.field = start.field;
    this.engineHours = start.engineHours;
    this.odometerMi = start.odometerMi;
    this.fuelPct = start.fuelPct;
    this.load = start.load;
    this.lastT = t0;
    this.lastPos = this.pos;
    this.push(t0);
  }

  get key(): string {
    return this.info.machine.key;
  }

  get lastTime(): number {
    return this.lastT;
  }

  private push(t: number): void {
    this.rec.pushValues(
      t,
      this.pos.x,
      this.pos.y,
      this.hdg,
      this.mps / MPH_TO_MPS,
      ACT_CODES[this.act],
      this.engineOn ? 1 : 0,
      this.field,
      this.engineHours,
      this.odometerMi,
      this.fuelPct,
    );
  }

  /** Integrate counters up to t with the current state and record a keyframe. */
  mark(t: number): void {
    const dtMs = t - this.lastT;
    if (dtMs < -1e-6) throw new RangeError(`${this.key}: time went backwards`);
    const dtH = Math.max(0, dtMs) / 3_600_000;
    if (this.engineOn && dtH > 0) {
      this.engineHours += dtH;
      const b = this.info.spec.burnGalPerHour;
      const burn =
        this.act === 'working' ? b.working : this.act === 'transport' ? b.transport : b.idle;
      this.fuelPct = Math.max(0, this.fuelPct - ((burn * dtH) / this.info.spec.fuelTankGal) * 100);
    }
    this.odometerMi += dist(this.lastPos, this.pos) / MILE_M;
    this.lastT = Math.max(this.lastT, t);
    this.lastPos = this.pos;
    this.push(this.lastT);
  }

  /** Change state at t: closes the old state's interval, then records the new state. */
  set(
    t: number,
    patch: { act?: Activity; engineOn?: boolean; field?: number; mps?: number },
  ): void {
    const changed =
      (patch.act !== undefined && patch.act !== this.act) ||
      (patch.engineOn !== undefined && patch.engineOn !== this.engineOn) ||
      (patch.field !== undefined && patch.field !== this.field) ||
      (patch.mps !== undefined && Math.abs(patch.mps - this.mps) > 1e-9);
    if (!changed) return;
    if (t > this.lastT) this.mark(t);
    if (patch.act !== undefined) this.act = patch.act;
    if (patch.engineOn !== undefined) this.engineOn = patch.engineOn;
    if (patch.field !== undefined) this.field = patch.field;
    if (patch.mps !== undefined) this.mps = patch.mps;
    this.mark(t);
  }

  /** Stand still until tEnd (keeps the current activity). */
  stay(t: number, tEnd: number): void {
    this.set(t, { mps: 0 });
    this.mark(tEnd);
  }

  /**
   * Drive along `trip` from time t (ms) for up to `rem` seconds. Returns the seconds left over
   * when the trip ends early (0 otherwise).
   */
  drive(trip: Trip, t: number, rem: number): number {
    let now = t;
    let left = rem;
    while (left > 1e-9 && !trip.done) {
      const leg = trip.legs[trip.li] as Leg;
      if (leg.path.length - trip.s < 1e-6) {
        trip.li++;
        trip.s = 0;
        continue;
      }
      this.set(now, { act: leg.act, field: leg.field, mps: leg.mps });
      const go = Math.min(leg.path.length - trip.s, leg.mps * left);
      for (const v of leg.path.verticesBetween(trip.s, trip.s + go)) {
        const tv = now + ((v - trip.s) / leg.mps) * 1000;
        this.pos = leg.path.at(v);
        this.hdg = leg.path.headingAt(v - 1e-6);
        this.mark(tv);
        this.hdg = leg.path.headingAt(v + 1e-6);
        this.mark(tv);
      }
      const used = go / leg.mps;
      trip.s += go;
      now += used * 1000;
      left -= used;
      this.pos = leg.path.at(trip.s);
      if (go > 1e-9) this.hdg = leg.path.headingAt(Math.max(0, trip.s - 1e-6));
      this.mark(now);
      if (leg.path.length - trip.s < 1e-6) {
        trip.li++;
        trip.s = 0;
      }
    }
    return trip.done ? left : 0;
  }

  /** Move along `path` from arc length s0 to s1 at `mps`, starting at t. Returns the end time. */
  runPath(
    path: Path,
    s0: number,
    s1: number,
    mps: number,
    act: Activity,
    field: number,
    t: number,
  ): number {
    this.set(t, { act, field, mps });
    for (const v of path.verticesBetween(s0, s1)) {
      const tv = t + ((v - s0) / mps) * 1000;
      this.pos = path.at(v);
      this.hdg = path.headingAt(v - 1e-6);
      this.mark(tv);
      this.hdg = path.headingAt(v + 1e-6);
      this.mark(tv);
    }
    const tEnd = t + ((s1 - s0) / mps) * 1000;
    this.pos = path.at(s1);
    if (s1 > s0) this.hdg = path.headingAt(Math.max(s0, s1 - 1e-6));
    this.mark(tEnd);
    return tEnd;
  }

  /**
   * Move straight toward `target` at `mps`. Returns the seconds left over once it arrives
   * (0 while still on the way).
   */
  pursue(target: Vec, mps: number, act: Activity, field: number, t: number, rem: number): number {
    const d = dist(this.pos, target);
    if (d < 1e-6) return rem;
    this.set(t, { act, field, mps });
    const can = mps * rem;
    if (d <= can) {
      this.hdg = headingOf(sub(target, this.pos));
      this.pos = target;
      const used = d / mps;
      this.mark(t + used * 1000);
      return rem - used;
    }
    const k = can / d;
    const delta = sub(target, this.pos);
    this.hdg = headingOf(delta);
    this.pos = { x: this.pos.x + delta.x * k, y: this.pos.y + delta.y * k };
    this.mark(t + rem * 1000);
    return 0;
  }

  /** Be at `p` with heading/speed of another machine for the next `rem` seconds. */
  follow(
    p: Vec,
    hdg: number,
    mps: number,
    act: Activity,
    field: number,
    t: number,
    rem: number,
  ): void {
    this.set(t, { act, field, mps });
    this.pos = p;
    this.hdg = hdg;
    this.mark(t + rem * 1000);
  }
}
