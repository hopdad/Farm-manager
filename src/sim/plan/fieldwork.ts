/**
 * A planter or sprayer working its field list in passes (planting-day, spray-windy): road to the
 * field, back-and-forth passes at implement width, a refill stop at the field entrance whenever
 * the seed / product runs out, optional "no-go" holds (wind) where it parks with the engine off,
 * and at stop time it finishes the pass and parks in the field for the night.
 */
import { MS } from '../time';
import { type Agent, mph, type Trip } from './agent';
import { type Coverage, pieceAt } from './coverage';
import { Actor, type DayEnv, type Op, WAIT, type WorkRange } from './day';
import { WARMUP_MS } from './harvest';
import { type Place, tripBetween } from './routes';

const SQ_M_PER_ACRE = 4046.86;

export interface FieldworkParams {
  machineKey: string;
  op: Exclude<Op, 'harvest'>;
  /** Field indexes in work order (cycled). */
  fields: number[];
  departAt: number;
  stopAt: number;
  /** Windows (epoch ms) when the machine must not work (e.g. wind over the label limit). */
  holds: { from: number; to: number }[];
}

type FwState =
  | 'parked'
  | 'warmup'
  | 'travel'
  | 'work'
  | 'toRefill'
  | 'refill'
  | 'backToWork'
  | 'toHold'
  | 'hold'
  | 'holdWarmup'
  | 'toPark'
  | 'night';

export class FieldworkActor extends Actor {
  st: FwState = 'parked';
  private place: Place;
  private cov: Coverage | null = null;
  private s = 0;
  private field = -1;
  private trip: Trip | null = null;
  private sinceFillM2 = 0;
  private waitUntil = 0;
  private hold: { from: number; to: number } | null = null;
  private work: WorkRange | null = null;
  private readonly widthM: number;
  private readonly workMps: number;
  private readonly turnMps: number;
  private readonly localMps: number;
  private readonly roadMps: number;
  private readonly fillM2: number;
  private readonly refillMs: number;

  constructor(
    a: Agent,
    env: DayEnv,
    private readonly p: FieldworkParams,
  ) {
    super(a, env);
    const sp = a.info.spec;
    this.widthM = (sp.implementWidthFt ?? 60) * 0.3048;
    this.workMps = mph(sp.workMph ?? 5);
    this.turnMps = mph(sp.turnMph ?? 3);
    this.localMps = mph(sp.fieldMph);
    this.roadMps = mph(sp.roadMph);
    this.fillM2 = (sp.acresPerFill ?? 100) * SQ_M_PER_ACRE;
    this.refillMs = (sp.refillMin ?? 15) * MS.MIN;
    this.place = a.field >= 0 ? { kind: 'field', idx: a.field } : { kind: 'shop' };
    const cursor = env.cursor[a.key] ?? 0;
    this.field = p.fields[cursor % p.fields.length] ?? -1;
  }

  get final(): boolean {
    return this.st === 'night';
  }

  private get key(): string {
    return `${this.p.op}:${this.field}`;
  }

  forceStop(t: number): void {
    if (this.final) return;
    this.closeWork();
    this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
    this.st = 'night';
    this.env.report.forcedStop.push(this.a.key);
  }

  override finish(_t: number): void {
    this.closeWork();
    if (this.cov && this.field >= 0) this.env.progress[this.key] = this.s;
  }

  private closeWork(): void {
    this.work = null;
  }

  private openWork(t: number): void {
    this.work = {
      machineKey: this.a.key,
      op: this.p.op,
      field: this.field,
      widthM: this.widthM,
      s0: this.s,
      s1: this.s,
      areaM2: 0,
      firstAt: t,
      lastAt: t,
    };
    this.env.report.work.push(this.work);
  }

  private speeds() {
    return { local: this.localMps, road: this.roadMps };
  }

  private goTo(field: number): void {
    const cov = this.env.ctx.fields[field]?.coverage(this.widthM);
    if (!cov) throw new Error(`no field ${field}`);
    let s = this.env.progress[`${this.p.op}:${field}`] ?? 0;
    if (s >= cov.path.length - 1e-6) s = 0;
    this.field = field;
    this.cov = cov;
    this.s = s;
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'field', idx: field },
      cov.path.at(s),
      this.speeds(),
    );
    this.st = 'travel';
  }

  private tripInField(point: { x: number; y: number }): Trip {
    return tripBetween(this.env.ctx, this.place, this.a.pos, this.place, point, this.speeds());
  }

  private holdAt(t: number): { from: number; to: number } | null {
    return this.p.holds.find((h) => t >= h.from && t < h.to) ?? null;
  }

  private parkFor(st: 'toPark' | 'toHold', k: number): void {
    const f = this.env.ctx.fields[this.field];
    if (!f) throw new Error('no field to park in');
    this.closeWork();
    this.trip = this.tripInField(f.parkSpot(k));
    this.st = st;
  }

  protected handle(now: number, rem: number): number {
    switch (this.st) {
      case 'parked':
        if (now >= this.p.departAt - WARMUP_MS && this.field >= 0) {
          this.a.set(now, { engineOn: true, act: 'idle' });
          this.st = 'warmup';
          return rem;
        }
        return WAIT;
      case 'warmup':
        if (now >= this.p.departAt) {
          this.goTo(this.field);
          return rem;
        }
        return WAIT;
      case 'travel':
      case 'backToWork': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.place = { kind: 'field', idx: this.field };
        if (this.st === 'travel' && t >= this.p.stopAt) {
          this.parkFor('toPark', 2);
          return left;
        }
        this.st = 'work';
        this.openWork(t);
        return left;
      }
      case 'work':
        return this.workStep(now, rem);
      case 'toRefill': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.a.set(t, { mps: 0, act: 'idle' });
        this.waitUntil = t + this.refillMs;
        this.st = 'refill';
        this.event(t, 'refill');
        return left;
      }
      case 'refill':
        if (now >= this.waitUntil) {
          this.sinceFillM2 = 0;
          this.trip = this.tripInField((this.cov as Coverage).path.at(this.s));
          this.st = 'backToWork';
          return rem;
        }
        return WAIT;
      case 'toHold': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
        this.st = 'hold';
        this.event(t, 'holding (no-go)');
        return left;
      }
      case 'hold': {
        const h = this.hold;
        if (!h || now >= h.to - 5 * MS.MIN) {
          this.a.set(now, { engineOn: true, act: 'idle' });
          this.st = 'holdWarmup';
          return rem;
        }
        return WAIT;
      }
      case 'holdWarmup': {
        const h = this.hold;
        if (!h || now >= h.to) {
          this.hold = null;
          if (now >= this.p.stopAt) {
            this.parkFor('toPark', 2);
            return rem;
          }
          this.trip = this.tripInField((this.cov as Coverage).path.at(this.s));
          this.st = 'backToWork';
          return rem;
        }
        return WAIT;
      }
      case 'toPark': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
        this.st = 'night';
        return left;
      }
      case 'night':
        return WAIT;
    }
  }

  private workStep(now: number, rem: number): number {
    const cov = this.cov as Coverage;
    if (this.s >= cov.path.length - 1e-6) return this.fieldDone(now, rem);
    const piece = pieceAt(cov, this.s);
    if (piece.kind === 'turn') {
      if (now >= this.p.stopAt) {
        this.parkFor('toPark', 2);
        return rem;
      }
      const hold = this.holdAt(now);
      if (hold) {
        this.hold = hold;
        this.parkFor('toHold', 2);
        return rem;
      }
      if (this.sinceFillM2 >= this.fillM2) {
        const f = this.env.ctx.fields[this.field];
        if (!f) throw new Error('no field');
        this.closeWork();
        this.trip = this.tripInField(f.dumpSpot);
        this.st = 'toRefill';
        return rem;
      }
      const go = Math.min(piece.s1 - this.s, this.turnMps * rem);
      this.a.runPath(cov.path, this.s, this.s + go, this.turnMps, 'working', this.field, now);
      this.s += go;
      return rem - go / this.turnMps;
    }
    const go = Math.min(piece.s1 - this.s, this.workMps * rem);
    const tEnd = this.a.runPath(
      cov.path,
      this.s,
      this.s + go,
      this.workMps,
      'working',
      this.field,
      now,
    );
    this.s += go;
    this.sinceFillM2 += go * cov.widthM;
    if (this.work) {
      this.work.s1 = this.s;
      this.work.areaM2 += go * cov.widthM;
      this.work.lastAt = tEnd;
    }
    return rem - go / this.workMps;
  }

  private fieldDone(now: number, rem: number): number {
    const cov = this.cov as Coverage;
    this.env.progress[this.key] = cov.path.length;
    this.closeWork();
    this.event(now, `finished field ${this.field}`);
    const cursor = (this.env.cursor[this.a.key] ?? 0) + 1;
    this.env.cursor[this.a.key] = cursor;
    const next = this.p.fields[cursor % this.p.fields.length] as number;
    if (now >= this.p.stopAt - 45 * MS.MIN) {
      this.parkFor('toPark', 2);
      return rem;
    }
    this.goTo(next);
    return rem;
  }
}
