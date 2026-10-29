/**
 * A machine's day as keyframes. The day planners push a point every simulation step (plus every
 * path vertex and state change, at their exact times); the recorder keeps only the points where
 * motion stops being linear, so a 15-hour day is a few thousand keyframes. Sampling is a binary
 * search plus linear interpolation: microseconds.
 *
 * Positions are EPSG:3078 metres and headings GRID degrees; the world converts on sampling.
 */
import { ACTIVITIES, type Activity } from '../../domain/fleet';
import { angleDiff, wrap360 } from '../geo/vec';

export interface Keyframe {
  /** Epoch ms (may be fractional). */
  t: number;
  x: number;
  y: number;
  /** Grid heading, degrees. */
  hdg: number;
  speedMph: number;
  act: Activity;
  engineOn: boolean;
  /** Field index in the day context, or -1. */
  field: number;
  engineHours: number;
  odometerMi: number;
  fuelPct: number;
}

const ACT_CODE = new Map(ACTIVITIES.map((a, i) => [a, i]));

/** Tolerances for "still on the same straight line". */
const TOL_XY = 0.02;
const TOL_HDG = 0.2;
const TOL_SPEED = 0.02;
const TOL_HOURS = 1e-7;
const TOL_ODO = 1e-7;
const TOL_FUEL = 1e-5;

/** Number of values per keyframe in the flat buffer. */
const W = 11;
// Offsets: t x y hdg speed act engine field hours odo fuel
const T = 0;
const X = 1;
const Y = 2;
const H = 3;
const S = 4;
const A = 5;
const E = 6;
const F = 7;
const HR = 8;
const OD = 9;
const FU = 10;

/**
 * Keyframe compression without per-point allocation: committed keyframes live in one flat
 * number array; the pending point and the current segment's slopes are scalars.
 */
export class TrackRecorder {
  private readonly buf: number[] = [];
  private readonly p = new Float64Array(W);
  private hasPending = false;
  private hasSlopes = false;
  private readonly slope = new Float64Array(W);

  get size(): number {
    return this.buf.length / W + (this.hasPending ? 1 : 0);
  }

  push(k: Keyframe): void {
    this.pushValues(
      k.t,
      k.x,
      k.y,
      k.hdg,
      k.speedMph,
      ACT_CODE.get(k.act) ?? 0,
      k.engineOn ? 1 : 0,
      k.field,
      k.engineHours,
      k.odometerMi,
      k.fuelPct,
    );
  }

  pushValues(
    t: number,
    x: number,
    y: number,
    hdg: number,
    speed: number,
    act: number,
    engine: number,
    field: number,
    hours: number,
    odo: number,
    fuel: number,
  ): void {
    const buf = this.buf;
    const n = buf.length;
    if (n === 0) {
      buf.push(t, x, y, hdg, speed, act, engine, field, hours, odo, fuel);
      return;
    }
    const a = n - W;
    const p = this.p;
    const lastT = this.hasPending ? (p[T] as number) : (buf[a + T] as number);
    if (t < lastT) throw new RangeError(`keyframes must be in time order (${t} < ${lastT})`);
    if (this.hasPending) {
      const sameDiscrete = p[A] === act && p[E] === engine && p[F] === field;
      if (t > (p[T] as number) && sameDiscrete && this.hasSlopes) {
        const s = this.slope;
        const dt = t - (buf[a + T] as number);
        if (
          Math.abs((buf[a + X] as number) + (s[X] as number) * dt - x) <= TOL_XY &&
          Math.abs((buf[a + Y] as number) + (s[Y] as number) * dt - y) <= TOL_XY &&
          Math.abs(angleDiff((buf[a + H] as number) + (s[H] as number) * dt, hdg)) <= TOL_HDG &&
          Math.abs((buf[a + S] as number) + (s[S] as number) * dt - speed) <= TOL_SPEED &&
          Math.abs((buf[a + HR] as number) + (s[HR] as number) * dt - hours) <= TOL_HOURS &&
          Math.abs((buf[a + OD] as number) + (s[OD] as number) * dt - odo) <= TOL_ODO &&
          Math.abs((buf[a + FU] as number) + (s[FU] as number) * dt - fuel) <= TOL_FUEL
        ) {
          p[T] = t;
          p[X] = x;
          p[Y] = y;
          p[H] = hdg;
          p[S] = speed;
          p[HR] = hours;
          p[OD] = odo;
          p[FU] = fuel;
          return;
        }
      }
      for (let i = 0; i < W; i++) buf.push(p[i] as number);
      this.hasPending = false;
    }
    // Start a new segment from the last committed keyframe.
    const b = buf.length - W;
    const bt = buf[b + T] as number;
    const sameDiscrete = buf[b + A] === act && buf[b + E] === engine && buf[b + F] === field;
    if (t <= bt || !sameDiscrete) {
      buf.push(t, x, y, hdg, speed, act, engine, field, hours, odo, fuel);
      this.hasSlopes = false;
      return;
    }
    const dt = t - bt;
    const s = this.slope;
    s[X] = (x - (buf[b + X] as number)) / dt;
    s[Y] = (y - (buf[b + Y] as number)) / dt;
    s[H] = angleDiff(buf[b + H] as number, hdg) / dt;
    s[S] = (speed - (buf[b + S] as number)) / dt;
    s[HR] = (hours - (buf[b + HR] as number)) / dt;
    s[OD] = (odo - (buf[b + OD] as number)) / dt;
    s[FU] = (fuel - (buf[b + FU] as number)) / dt;
    this.hasSlopes = true;
    p[T] = t;
    p[X] = x;
    p[Y] = y;
    p[H] = hdg;
    p[S] = speed;
    p[A] = act;
    p[E] = engine;
    p[F] = field;
    p[HR] = hours;
    p[OD] = odo;
    p[FU] = fuel;
    this.hasPending = true;
  }

  freeze(): Track {
    if (this.hasPending) {
      for (let i = 0; i < W; i++) this.buf.push(this.p[i] as number);
      this.hasPending = false;
    }
    return Track.fromFlat(this.buf);
  }
}

/** One sample in planner units (EPSG:3078, grid heading). */
export interface TrackSample {
  x: number;
  y: number;
  hdg: number;
  speedMph: number;
  act: Activity;
  engineOn: boolean;
  field: number;
  engineHours: number;
  odometerMi: number;
  fuelPct: number;
}

export class Track {
  readonly n: number;
  readonly t: Float64Array;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly hdg: Float32Array;
  private readonly spd: Float32Array;
  private readonly act: Uint8Array;
  private readonly eng: Uint8Array;
  private readonly fld: Int16Array;
  private readonly hrs: Float64Array;
  private readonly odo: Float64Array;
  private readonly fuel: Float32Array;

  private constructor(n: number) {
    if (n < 1) throw new RangeError('a track needs at least one keyframe');
    this.n = n;
    this.t = new Float64Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.hdg = new Float32Array(n);
    this.spd = new Float32Array(n);
    this.act = new Uint8Array(n);
    this.eng = new Uint8Array(n);
    this.fld = new Int16Array(n);
    this.hrs = new Float64Array(n);
    this.odo = new Float64Array(n);
    this.fuel = new Float32Array(n);
  }

  static fromFlat(buf: readonly number[]): Track {
    const n = buf.length / W;
    const tr = new Track(n);
    for (let i = 0; i < n; i++) {
      const o = i * W;
      tr.t[i] = buf[o + T] as number;
      tr.x[i] = buf[o + X] as number;
      tr.y[i] = buf[o + Y] as number;
      tr.hdg[i] = wrap360(buf[o + H] as number);
      tr.spd[i] = buf[o + S] as number;
      tr.act[i] = buf[o + A] as number;
      tr.eng[i] = buf[o + E] as number;
      tr.fld[i] = buf[o + F] as number;
      tr.hrs[i] = buf[o + HR] as number;
      tr.odo[i] = buf[o + OD] as number;
      tr.fuel[i] = buf[o + FU] as number;
    }
    return tr;
  }

  static fromKeyframes(frames: readonly Keyframe[]): Track {
    const rec = new TrackRecorder();
    for (const f of frames) rec.push(f);
    return rec.freeze();
  }

  get startsAt(): number {
    return this.t[0] as number;
  }

  get endsAt(): number {
    return this.t[this.n - 1] as number;
  }

  /** Index of the last keyframe with t <= time (0 before the first). */
  private indexAt(time: number): number {
    const t = this.t;
    if (time <= (t[0] as number)) return 0;
    let lo = 0;
    let hi = this.n - 1;
    if (time >= (t[hi] as number)) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((t[mid] as number) <= time) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  sample(time: number): TrackSample {
    const i = this.indexAt(time);
    const j = Math.min(i + 1, this.n - 1);
    const ti = this.t[i] as number;
    const tj = this.t[j] as number;
    const f = j > i && tj > ti ? Math.max(0, Math.min(1, (time - ti) / (tj - ti))) : 0;
    const mix = (arr: Float64Array | Float32Array) =>
      (arr[i] as number) + ((arr[j] as number) - (arr[i] as number)) * f;
    const hi = this.hdg[i] as number;
    return {
      x: mix(this.x),
      y: mix(this.y),
      hdg: wrap360(hi + angleDiff(hi, this.hdg[j] as number) * f),
      speedMph: Math.max(0, mix(this.spd)),
      act: ACTIVITIES[this.act[i] as number] as Activity,
      engineOn: this.eng[i] === 1,
      field: this.fld[i] as number,
      engineHours: mix(this.hrs),
      odometerMi: mix(this.odo),
      fuelPct: mix(this.fuel),
    };
  }

  /** All keyframe times (for checks and plots). */
  times(): Float64Array {
    return this.t;
  }
}
