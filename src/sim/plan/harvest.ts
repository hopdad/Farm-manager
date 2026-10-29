/**
 * Harvest crews (plan §5: "combines in passes, carts, semis on section roads to elevators").
 *
 *  - A combine harvests its field list in back-and-forth passes at header width. Grain fills
 *    the tank at (width x speed x yield); at 60 % it calls its cart; full and no cart = it stops.
 *  - The cart pursues the combine, runs alongside on the harvested side while the combine
 *    unloads on the go (the combine waits at the pass end rather than turn mid-unload), and
 *    once ~70 % full drives to the truck staged at the field entrance and dumps into it.
 *  - Trucks wait in staging slots at the entrance, leave when ~full for the nearest elevator by
 *    road, join its queue (other farms' trucks ahead of them are counted, not drawn), creep up
 *    the lane, unload at the pit and return to whichever crew has the fewest trucks.
 *  - At stop time combines finish the pass, hand their last grain to the cart and park in the
 *    field; trucks deliver what they have and go home to the shop.
 */
import { add, dist, scale, signedDistanceToRing, type Vec } from '../geo/vec';
import type { Rng } from '../rng';
import { localParts, MS } from '../time';
import { type Agent, mph, type Trip } from './agent';
import { type ElevatorGeo, TRUCK_SPACING_M } from './context';
import { type Coverage, pieceAt } from './coverage';
import { Actor, type DayEnv, WAIT, type WorkRange } from './day';
import { type Place, roadMiles, tripBetween } from './routes';

export const WARMUP_MS = 10 * MS.MIN;
/** The combine calls its cart at this tank fill. */
const CALL_CART_AT = 0.6;
/** The cart heads for the truck at this fill. */
const CART_DUMP_AT = 0.7;
/** A truck leaves for the elevator at this fill. */
const TRUCK_FULL_AT = 0.95;
/** Cart's centre is this far beyond the header edge while unloading. */
const UNLOAD_OFFSET_EXTRA_M = 3.5;
const QUEUE_CREEP_MPH = 3;
const YARD_MPH = 6;

export interface CrewDef {
  combineKey: string;
  cartKey: string;
  /** Field indexes in harvest order (cycled). */
  fields: number[];
}

export interface HarvestParams {
  crews: CrewDef[];
  semiKeys: string[];
  combineDepartAt: number;
  cartDepartAt: number;
  semiDepartAt: number[];
  stopAt: number;
  breakdown?: { machineKey: string; at: number };
  /** Bushels per square metre on a field (this year's corn). */
  yieldBuPerM2(field: number): number;
}

export interface Crew {
  idx: number;
  combine: CombineActor;
  cart: CartActor;
  fields: number[];
  workField: number;
}

/** Shared harvest state for one day. */
export class HarvestDay {
  readonly crews: Crew[] = [];
  readonly semis: SemiActor[] = [];
  readonly queues = new Map<number, SemiActor[]>();
  readonly elevators: ElevatorQueue[];
  private readonly nearestElevator = new Map<number, number>();

  constructor(
    readonly env: DayEnv,
    readonly params: HarvestParams,
    elevatorRng: (idx: number) => Rng,
  ) {
    this.elevators = env.ctx.elevators.map((g) => new ElevatorQueue(g, elevatorRng(g.idx)));
  }

  fieldQueue(field: number): SemiActor[] {
    let q = this.queues.get(field);
    if (!q) {
      q = [];
      this.queues.set(field, q);
    }
    return q;
  }

  elevatorFor(field: number): number {
    let e = this.nearestElevator.get(field);
    if (e === undefined) {
      let best = Number.POSITIVE_INFINITY;
      e = 0;
      for (const g of this.env.ctx.elevators) {
        const d = roadMiles(
          this.env.ctx,
          { kind: 'field', idx: field },
          { kind: 'elevator', idx: g.idx },
        );
        if (d < best) {
          best = d;
          e = g.idx;
        }
      }
      this.nearestElevator.set(field, e);
    }
    return e;
  }

  crewActive(c: Crew): boolean {
    return (c.combine.st !== 'night' && c.combine.st !== 'down') || c.cart.a.load > 1;
  }

  /** Crew that should get this truck next, or null when nobody needs trucks. */
  pickCrew(semi: SemiActor): Crew | null {
    const active = this.crews.filter((c) => this.crewActive(c));
    if (!active.length) return null;
    const busy = (c: Crew) =>
      this.semis.filter(
        (s) =>
          s !== semi && s.crew === c && s.st !== 'night' && s.st !== 'toShop' && s.st !== 'parked',
      ).length;
    return (
      [...active].sort(
        (a, b) =>
          busy(a) - busy(b) ||
          (a === semi.crew ? 0 : 1) - (b === semi.crew ? 0 : 1) ||
          a.idx - b.idx,
      )[0] ?? null
    );
  }

  /** The truck being loaded at a field's slot 0, if it is there and has room. */
  truckAtSlot0(field: number): SemiActor | null {
    const s = this.fieldQueue(field)[0];
    if (s?.st !== 'atField' || !s.atSlot) return null;
    return s.room > 1 ? s : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Combine
// ---------------------------------------------------------------------------------------------

type CombineState =
  | 'parked'
  | 'warmup'
  | 'travel'
  | 'harvest'
  | 'waitCart'
  | 'waitUnload'
  | 'drain'
  | 'finishing'
  | 'toPark'
  | 'night'
  | 'down';

export class CombineActor extends Actor {
  st: CombineState;
  crew!: Crew;
  cov: Coverage | null = null;
  s = 0;
  unloading = false;
  place: Place;
  private trip: Trip | null = null;
  private work: WorkRange | null = null;
  private nextField = -1;
  readonly cap: number;
  readonly widthM: number;
  private readonly workMps: number;
  private readonly turnMps: number;
  private readonly localMps: number;
  private readonly roadMps: number;

  constructor(
    a: Agent,
    env: DayEnv,
    private readonly day: HarvestDay,
  ) {
    super(a, env);
    const sp = a.info.spec;
    this.cap = sp.capacityBu ?? 400;
    this.widthM = (sp.implementWidthFt ?? 30) * 0.3048;
    this.workMps = mph(sp.workMph ?? 4.5);
    this.turnMps = mph(sp.turnMph ?? 2.5);
    this.localMps = mph(sp.fieldMph);
    this.roadMps = mph(sp.roadMph);
    this.place = a.field >= 0 ? { kind: 'field', idx: a.field } : { kind: 'shop' };
    this.st = env.down.has(a.key) ? 'down' : 'parked';
  }

  get final(): boolean {
    return this.st === 'night' || this.st === 'down';
  }

  get workField(): number {
    return this.crew.workField;
  }

  private get progressKey(): string {
    return `harvest:${this.crew.workField}`;
  }

  /** Whether the cart should come now. */
  get needsCart(): boolean {
    const inField =
      this.st === 'harvest' ||
      this.st === 'waitCart' ||
      this.st === 'waitUnload' ||
      this.st === 'drain' ||
      this.st === 'finishing';
    if (!inField) return false;
    if (this.st === 'waitCart') return true;
    if ((this.st === 'drain' || this.st === 'finishing') && this.a.load > 0.5) return true;
    return this.a.load >= CALL_CART_AT * this.cap;
  }

  /** Whether a cart alongside can start receiving grain now. */
  get canReceive(): boolean {
    if (this.st === 'waitCart' || this.st === 'waitUnload' || this.st === 'drain') return true;
    if (this.st === 'finishing') return true;
    if (this.st !== 'harvest' || !this.cov) return false;
    return pieceAt(this.cov, this.s).kind === 'pass';
  }

  /**
   * Where the cart runs while receiving: beside the combine on the harvested side of the pass
   * it is on (or has just finished, when it waits at the headland). Never outside the field.
   */
  unloadPoint(): Vec {
    const cov = this.cov;
    if (!cov) return this.a.pos;
    const piece = pieceAt(cov, Math.min(this.s, cov.path.length));
    const atTurnStart = piece.kind === 'turn' && this.s - piece.s0 < 0.5;
    const passIdx = Math.min(
      cov.passes.length - 1,
      piece.kind === 'pass' || atTurnStart ? piece.pass : piece.pass + 1,
    );
    const side = cov.passes[passIdx]?.workedSide ?? { x: 0, y: 0 };
    const off = this.widthM / 2 + UNLOAD_OFFSET_EXTRA_M;
    const ring = this.env.ctx.fields[this.crew.workField]?.ring;
    const preferred = add(this.a.pos, scale(side, off));
    if (!ring || signedDistanceToRing(preferred, ring) <= -1.5) return preferred;
    const other = add(this.a.pos, scale(side, -off));
    if (signedDistanceToRing(other, ring) <= -1.5) return other;
    // Tight corner (a headland turn): run just behind the combine instead.
    return this.a.pos;
  }

  forceStop(t: number): void {
    if (this.final) return;
    this.endWork(t);
    this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
    this.st = 'night';
    this.env.report.forcedStop.push(this.a.key);
  }

  override finish(t: number): void {
    this.endWork(t);
    if (this.cov) this.env.progress[this.progressKey] = this.s;
  }

  private goTo(field: number, now: number): void {
    const cov = this.env.ctx.fields[field]?.coverage(this.widthM);
    if (!cov) throw new Error(`no field ${field}`);
    const key = `harvest:${field}`;
    let s = this.env.progress[key] ?? 0;
    if (s >= cov.path.length - 1e-6) s = 0;
    this.cov = cov;
    this.s = s;
    this.crew.workField = field;
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'field', idx: field },
      cov.path.at(s),
      {
        local: this.localMps,
        road: this.roadMps,
      },
    );
    this.st = 'travel';
    this.event(now, `to field ${field}`);
  }

  private beginWork(t: number): void {
    this.work = {
      machineKey: this.a.key,
      op: 'harvest',
      field: this.crew.workField,
      widthM: this.widthM,
      s0: this.s,
      s1: this.s,
      areaM2: 0,
      firstAt: t,
      lastAt: t,
    };
    this.env.report.work.push(this.work);
  }

  private endWork(_t: number): void {
    this.work = null;
  }

  protected handle(now: number, rem: number): number {
    const p = this.day.params;
    if (p.breakdown?.machineKey === this.a.key && now >= p.breakdown.at && this.st !== 'down') {
      this.endWork(now);
      if (this.cov) this.env.progress[this.progressKey] = this.s;
      this.unloading = false;
      this.st = 'down';
      this.env.down.add(this.a.key);
      this.a.set(now, { mps: 0, act: 'idle', engineOn: false });
      this.event(now, 'broke down');
      return rem;
    }
    switch (this.st) {
      case 'parked':
        if (now >= p.combineDepartAt - WARMUP_MS) {
          this.a.set(now, { engineOn: true, act: 'idle' });
          this.st = 'warmup';
          return rem;
        }
        return WAIT;
      case 'warmup':
        if (now >= p.combineDepartAt) {
          this.goTo(this.crew.workField, now);
          return rem;
        }
        return WAIT;
      case 'travel': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.place = { kind: 'field', idx: this.crew.workField };
        if (t >= p.stopAt) {
          this.st = 'finishing';
        } else {
          this.st = 'harvest';
          this.beginWork(t);
        }
        return left;
      }
      case 'harvest':
        return this.harvest(now, rem);
      case 'waitCart':
        if (this.unloading) {
          this.st = 'harvest';
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'idle' });
        return WAIT;
      case 'waitUnload':
        if (!this.unloading) {
          this.st = 'harvest';
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'working' });
        return WAIT;
      case 'drain':
        if (this.a.load <= 0.5 && !this.unloading) {
          this.goTo(this.nextField, now);
          return rem;
        }
        this.a.set(now, { mps: 0, act: this.unloading ? 'working' : 'idle' });
        return WAIT;
      case 'finishing': {
        const late = now >= p.stopAt + 150 * MS.MIN;
        if ((this.a.load <= 0.5 && !this.unloading) || late) {
          this.endWork(now);
          const f = this.env.ctx.fields[this.crew.workField];
          if (!f) throw new Error('combine has no field');
          this.trip = tripBetween(this.env.ctx, this.place, this.a.pos, this.place, f.parkSpot(0), {
            local: this.localMps,
            road: this.roadMps,
          });
          this.st = 'toPark';
          return rem;
        }
        this.a.set(now, { mps: 0, act: this.unloading ? 'working' : 'idle' });
        return WAIT;
      }
      case 'toPark': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
        this.st = 'night';
        this.event(t, 'parked for the night');
        return left;
      }
      case 'night':
      case 'down':
        return WAIT;
    }
  }

  private harvest(now: number, rem: number): number {
    const cov = this.cov as Coverage;
    const field = this.crew.workField;
    if (this.s >= cov.path.length - 1e-6) return this.fieldDone(now, rem);
    const piece = pieceAt(cov, this.s);
    if (piece.kind === 'turn') {
      if (this.unloading) {
        this.st = 'waitUnload';
        return rem;
      }
      if (now >= this.day.params.stopAt) {
        this.st = 'finishing';
        this.endWork(now);
        return rem;
      }
      const go = Math.min(piece.s1 - this.s, this.turnMps * rem);
      this.a.runPath(cov.path, this.s, this.s + go, this.turnMps, 'working', field, now);
      this.s += go;
      return rem - go / this.turnMps;
    }
    const perM = cov.widthM * this.day.params.yieldBuPerM2(field);
    const room = this.cap - this.a.load;
    if (!this.unloading && room <= 1e-6) {
      this.st = 'waitCart';
      return rem;
    }
    let go = Math.min(piece.s1 - this.s, this.workMps * rem);
    if (!this.unloading) go = Math.min(go, room / perM);
    if (go <= 1e-9) {
      this.st = 'waitCart';
      return rem;
    }
    const tEnd = this.a.runPath(cov.path, this.s, this.s + go, this.workMps, 'working', field, now);
    this.s += go;
    this.a.load += go * perM;
    if (this.work) {
      this.work.s1 = this.s;
      this.work.areaM2 += go * cov.widthM;
      this.work.lastAt = tEnd;
    }
    return rem - go / this.workMps;
  }

  private fieldDone(now: number, rem: number): number {
    this.endWork(now);
    const cov = this.cov as Coverage;
    this.env.progress[this.progressKey] = cov.path.length;
    this.event(now, `finished field ${this.crew.workField}`);
    const key = this.a.key;
    const n = this.crew.fields.length;
    const cursor = (this.env.cursor[key] ?? 0) + 1;
    this.env.cursor[key] = cursor;
    const next = this.crew.fields[cursor % n] as number;
    if (now >= this.day.params.stopAt - 75 * MS.MIN) {
      this.st = 'finishing';
      return rem;
    }
    this.nextField = next;
    this.st = 'drain';
    return rem;
  }
}

// ---------------------------------------------------------------------------------------------
// Grain cart
// ---------------------------------------------------------------------------------------------

type CartState =
  | 'parked'
  | 'warmup'
  | 'travel'
  | 'standby'
  | 'approach'
  | 'sync'
  | 'toDump'
  | 'waitSemi'
  | 'dump'
  | 'toPark'
  | 'night';

export class CartActor extends Actor {
  st: CartState = 'parked';
  crew!: Crew;
  place: Place;
  private trip: Trip | null = null;
  private target: SemiActor | null = null;
  readonly cap: number;
  private readonly rate: number;
  private readonly localMps: number;
  private readonly roadMps: number;

  constructor(
    a: Agent,
    env: DayEnv,
    private readonly day: HarvestDay,
  ) {
    super(a, env);
    const sp = a.info.spec;
    this.cap = sp.capacityBu ?? 1000;
    this.rate = sp.unloadBuPerSec ?? 8;
    this.localMps = mph(sp.fieldMph);
    this.roadMps = mph(sp.roadMph);
    this.place = a.field >= 0 ? { kind: 'field', idx: a.field } : { kind: 'shop' };
  }

  get final(): boolean {
    return this.st === 'night' || (this.st === 'parked' && !this.day.crewActive(this.crew));
  }

  private get fieldIdx(): number {
    return this.place.kind === 'field' ? this.place.idx : -1;
  }

  forceStop(t: number): void {
    if (this.st === 'night' || this.st === 'parked') return;
    if (this.st === 'sync') this.crew.combine.unloading = false;
    this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
    this.st = 'night';
    this.env.report.forcedStop.push(this.a.key);
  }

  private travelTo(field: number): void {
    const f = this.env.ctx.fields[field];
    if (!f) throw new Error(`no field ${field}`);
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'field', idx: field },
      f.dumpSpot,
      {
        local: this.localMps,
        road: this.roadMps,
      },
    );
    this.st = 'travel';
  }

  private toDump(): void {
    const f = this.env.ctx.fields[this.fieldIdx];
    if (!f) throw new Error('cart is not in a field');
    this.trip = tripBetween(this.env.ctx, this.place, this.a.pos, this.place, f.dumpSpot, {
      local: this.localMps,
      road: this.roadMps,
    });
    this.st = 'toDump';
  }

  protected handle(now: number, rem: number): number {
    const c = this.crew.combine;
    const p = this.day.params;
    switch (this.st) {
      case 'parked':
        if (!this.day.crewActive(this.crew) || c.st === 'down') return WAIT;
        if (now >= p.cartDepartAt - WARMUP_MS) {
          this.a.set(now, { engineOn: true, act: 'idle' });
          this.st = 'warmup';
          return rem;
        }
        return WAIT;
      case 'warmup':
        if (now >= p.cartDepartAt) {
          this.travelTo(this.crew.workField);
          return rem;
        }
        return WAIT;
      case 'travel': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        this.place = { kind: 'field', idx: this.crew.workField };
        this.st = 'standby';
        return left;
      }
      case 'standby': {
        const here = this.fieldIdx;
        const combineGone = c.st === 'down' || c.st === 'night' || c.st === 'toPark';
        if (this.crew.workField !== here && !combineGone) {
          if (this.a.load > 1 && this.day.truckAtSlot0(here)) {
            this.toDump();
            return rem;
          }
          this.travelTo(this.crew.workField);
          return rem;
        }
        if (
          c.needsCart &&
          c.workField === here &&
          c.st !== 'travel' &&
          this.cap - this.a.load >= 60
        ) {
          this.st = 'approach';
          return rem;
        }
        if (this.a.load >= CART_DUMP_AT * this.cap || (this.a.load > 1 && combineGone)) {
          this.toDump();
          return rem;
        }
        if (this.a.load <= 1 && combineGone && here >= 0) {
          const f = this.env.ctx.fields[here];
          if (!f) throw new Error('cart has no field');
          this.trip = tripBetween(this.env.ctx, this.place, this.a.pos, this.place, f.parkSpot(1), {
            local: this.localMps,
            road: this.roadMps,
          });
          this.st = 'toPark';
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'idle' });
        return WAIT;
      }
      case 'approach': {
        const here = this.fieldIdx;
        if (c.st === 'down' || c.workField !== here || (!c.needsCart && c.a.load < 0.25 * c.cap)) {
          this.st = 'standby';
          return rem;
        }
        const target = c.unloadPoint();
        const left = this.a.pursue(target, this.localMps, 'transport', here, now, rem);
        if (dist(this.a.pos, target) > 0.05) return left;
        if (c.canReceive) {
          this.st = 'sync';
          c.unloading = true;
          return left;
        }
        // Alongside but the combine is turning: keep station until the next pass.
        if (left > 0)
          this.a.follow(
            target,
            c.a.hdg,
            c.a.mps,
            'transport',
            here,
            now + (rem - left) * 1000,
            left,
          );
        return 0;
      }
      case 'sync': {
        const here = this.fieldIdx;
        if (c.st === 'down' || c.workField !== here) {
          c.unloading = false;
          this.st = 'standby';
          return rem;
        }
        const amount = Math.max(0, Math.min(c.a.load, this.rate * rem, this.cap - this.a.load));
        c.a.load -= amount;
        this.a.load += amount;
        this.a.follow(c.unloadPoint(), c.a.hdg, c.a.mps, 'working', here, now, rem);
        if (c.a.load <= 0.5 || this.a.load >= this.cap - 0.5) {
          c.unloading = false;
          const leaving = c.st === 'finishing' || c.st === 'drain';
          if (this.a.load >= CART_DUMP_AT * this.cap || (leaving && this.a.load > 1)) this.toDump();
          else this.st = 'standby';
        }
        return 0;
      }
      case 'toDump': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        this.st = 'waitSemi';
        return left;
      }
      case 'waitSemi': {
        const here = this.fieldIdx;
        const semi = this.day.truckAtSlot0(here);
        if (semi) {
          this.target = semi;
          this.st = 'dump';
          return rem;
        }
        if (this.a.load <= 1) {
          this.st = 'standby';
          return rem;
        }
        if (
          c.needsCart &&
          c.workField === here &&
          c.a.load >= 0.9 * c.cap &&
          this.cap - this.a.load >= 150 &&
          c.st !== 'down'
        ) {
          this.st = 'approach';
          return rem;
        }
        const anyTruckHere = this.day.fieldQueue(here).length > 0;
        if (this.crew.workField !== here && !anyTruckHere && c.st !== 'down') {
          this.travelTo(this.crew.workField);
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'idle' });
        return WAIT;
      }
      case 'dump': {
        const semi = this.target;
        if (!semi || semi !== this.day.truckAtSlot0(this.fieldIdx)) {
          this.target = null;
          this.st = 'waitSemi';
          return rem;
        }
        const amount = Math.max(0, Math.min(this.a.load, this.rate * rem, semi.room));
        this.a.load -= amount;
        semi.receive(amount, this.fieldIdx);
        this.a.set(now, { mps: 0, act: 'working' });
        this.a.mark(now + rem * 1000);
        if (this.a.load <= 0.5) {
          this.target = null;
          this.st = 'standby';
        } else if (semi.room <= 1) {
          this.target = null;
          this.st = 'waitSemi';
        }
        return 0;
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
}

// ---------------------------------------------------------------------------------------------
// Semi
// ---------------------------------------------------------------------------------------------

type SemiState =
  | 'parked'
  | 'warmup'
  | 'toField'
  | 'atField'
  | 'toElevator'
  | 'queued'
  | 'toPit'
  | 'unloading'
  | 'toShop'
  | 'night';

export class SemiActor extends Actor {
  st: SemiState = 'parked';
  crew: Crew | null = null;
  place: Place;
  atSlot = false;
  laneS = 0;
  private trip: Trip | null = null;
  private targetField = -1;
  private elevator = -1;
  private unloadEnd = 0;
  private serviceMin = 7;
  private loadedFrom = -1;
  private arrivedAt = 0;
  readonly cap: number;
  private readonly localMps: number;

  constructor(
    a: Agent,
    env: DayEnv,
    private readonly day: HarvestDay,
    private readonly departAt: number,
  ) {
    super(a, env);
    this.cap = a.info.spec.capacityBu ?? 1000;
    this.localMps = mph(a.info.spec.fieldMph);
    this.place = { kind: 'shop' };
  }

  get final(): boolean {
    return (
      this.st === 'night' ||
      (this.st === 'parked' && !this.day.crews.some((c) => this.day.crewActive(c)))
    );
  }

  get room(): number {
    return this.cap - this.a.load;
  }

  /** Grain from a cart. */
  receive(bu: number, field: number): void {
    this.a.load += bu;
    if (this.loadedFrom < 0) this.loadedFrom = field;
  }

  /** The elevator calls the truck to the pit. */
  callToPit(serviceMin: number): void {
    this.serviceMin = serviceMin;
    this.st = 'toPit';
  }

  private speeds() {
    const sp = this.a.info.spec;
    const loaded = this.a.load > 0.5 * this.cap;
    return {
      local: this.localMps,
      road: mph(loaded ? (sp.loadedRoadMph ?? sp.roadMph) : sp.roadMph),
    };
  }

  forceStop(t: number): void {
    if (this.st === 'night' || this.st === 'parked') return;
    this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
    this.st = 'night';
    this.env.report.forcedStop.push(this.a.key);
  }

  private leaveField(): void {
    if (this.place.kind === 'approach') {
      const q = this.day.fieldQueue(this.place.idx);
      const i = q.indexOf(this);
      if (i >= 0) q.splice(i, 1);
    }
    this.atSlot = false;
  }

  private goToField(field: number): void {
    const f = this.env.ctx.fields[field];
    if (!f) throw new Error(`no field ${field}`);
    this.leaveField();
    const slot = f.slot(this.day.fieldQueue(field).length);
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'approach', idx: field },
      slot,
      this.speeds(),
    );
    this.targetField = field;
    this.st = 'toField';
  }

  private goToElevator(): void {
    const from = this.place.kind === 'approach' ? this.place.idx : this.loadedFrom;
    this.elevator = this.day.elevatorFor(Math.max(from, 0));
    this.leaveField();
    const g = this.env.ctx.elevators[this.elevator] as ElevatorGeo;
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'elevator', idx: this.elevator },
      g.lane.start,
      this.speeds(),
    );
    this.st = 'toElevator';
  }

  private goHome(): void {
    this.leaveField();
    this.trip = tripBetween(
      this.env.ctx,
      this.place,
      this.a.pos,
      { kind: 'shop' },
      this.env.ctx.shop.slot(this.a.info.idx),
      this.speeds(),
    );
    this.st = 'toShop';
  }

  private nextAssignment(now: number): void {
    const crew = this.day.pickCrew(this);
    this.crew = crew;
    if (crew) {
      this.goToField(crew.workField);
      this.event(now, `to field ${crew.workField}`);
    } else {
      this.goHome();
      this.event(now, 'home');
    }
  }

  protected handle(now: number, rem: number): number {
    switch (this.st) {
      case 'parked':
        if (
          now >= this.departAt - WARMUP_MS &&
          this.day.crews.some((c) => this.day.crewActive(c))
        ) {
          this.a.set(now, { engineOn: true, act: 'idle' });
          this.st = 'warmup';
          return rem;
        }
        return WAIT;
      case 'warmup':
        if (now >= this.departAt) {
          const crew = this.day.pickCrew(this);
          if (!crew) {
            this.a.set(now, { engineOn: false, act: 'idle' });
            this.st = 'parked';
            return WAIT;
          }
          this.crew = crew;
          this.goToField(crew.workField);
          return rem;
        }
        return WAIT;
      case 'toField': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        this.place = { kind: 'approach', idx: this.targetField };
        this.day.fieldQueue(this.targetField).push(this);
        this.st = 'atField';
        return left;
      }
      case 'atField': {
        const field = (this.place as { idx: number }).idx;
        const f = this.env.ctx.fields[field];
        if (!f) throw new Error('semi has no field');
        const k = this.day.fieldQueue(field).indexOf(this);
        const target = f.slot(Math.max(0, k));
        if (dist(this.a.pos, target) > 0.3) {
          this.atSlot = false;
          return this.a.pursue(target, mph(YARD_MPH), 'transport', -1, now, rem);
        }
        this.atSlot = k === 0;
        const crew = this.crew;
        if (this.a.load >= TRUCK_FULL_AT * this.cap) {
          this.goToElevator();
          return rem;
        }
        if (crew && crew.workField !== field && crew.combine.st !== 'down') {
          if (this.a.load >= 0.5 * this.cap) this.goToElevator();
          else this.goToField(crew.workField);
          return rem;
        }
        if (!crew || !this.day.crewActive(crew)) {
          if (this.a.load > 1) this.goToElevator();
          else this.nextAssignment(now);
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'idle' });
        return WAIT;
      }
      case 'toElevator': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.place = { kind: 'elevator', idx: this.elevator };
        this.arrivedAt = t;
        this.laneS = 0;
        this.day.elevators[this.elevator]?.arrive(this, t);
        this.st = 'queued';
        return left;
      }
      case 'queued': {
        const q = this.day.elevators[this.elevator] as ElevatorQueue;
        const target = q.laneTarget(this);
        if (target > this.laneS + 0.01) {
          const v = mph(QUEUE_CREEP_MPH);
          const go = Math.min(target - this.laneS, v * rem);
          this.a.runPath(q.geo.lane, this.laneS, this.laneS + go, v, 'queued', -1, now);
          this.laneS += go;
          return rem - go / v;
        }
        this.a.set(now, { mps: 0, act: 'queued' });
        return WAIT;
      }
      case 'toPit': {
        const q = this.day.elevators[this.elevator] as ElevatorQueue;
        const end = q.geo.lane.length;
        if (this.laneS < end - 0.01) {
          const v = mph(YARD_MPH);
          const go = Math.min(end - this.laneS, v * rem);
          this.a.runPath(q.geo.lane, this.laneS, this.laneS + go, v, 'queued', -1, now);
          this.laneS += go;
          return rem - go / v;
        }
        this.unloadEnd = now + this.serviceMin * MS.MIN;
        this.a.set(now, { mps: 0, act: 'idle' });
        this.st = 'unloading';
        return rem;
      }
      case 'unloading':
        if (now >= this.unloadEnd) {
          this.env.report.loads.push({
            semiKey: this.a.key,
            elevator: this.elevator,
            field: this.loadedFrom,
            bushels: Math.round(this.a.load * 10) / 10,
            arrivedAt: this.arrivedAt,
            unloadedAt: now,
          });
          this.a.load = 0;
          this.loadedFrom = -1;
          this.nextAssignment(now);
          return rem;
        }
        this.a.set(now, { mps: 0, act: 'idle' });
        return WAIT;
      case 'toShop': {
        const trip = this.trip as Trip;
        const left = this.a.drive(trip, now, rem);
        if (!trip.done) return 0;
        const t = now + (rem - left) * 1000;
        this.place = { kind: 'shop' };
        this.a.set(t, { mps: 0, act: 'idle', engineOn: false });
        this.st = 'night';
        return left;
      }
      case 'night':
        return WAIT;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Elevator queue
// ---------------------------------------------------------------------------------------------

interface QueueEntry {
  semi: SemiActor | null;
  serviceMin: number;
}

/** One pit, FIFO. Other farms' trucks are queue entries without a semi (not drawn). */
export class ElevatorQueue {
  private readonly entries: QueueEntry[] = [];
  private serving: QueueEntry | null = null;
  private serviceEnd = 0;

  constructor(
    readonly geo: ElevatorGeo,
    private readonly rng: Rng,
  ) {}

  arrive(semi: SemiActor, t: number): void {
    const hour = localParts(t).hh;
    const busy = hour >= 10 && hour < 17 ? 3 : hour >= 17 && hour < 21 ? 2 : 1;
    const ahead = this.rng.int(0, busy);
    for (let k = 0; k < ahead; k++)
      this.entries.push({ semi: null, serviceMin: this.rng.int(5, 8) });
    this.entries.push({ semi, serviceMin: this.rng.int(6, 8) });
  }

  step(t: number): void {
    const s = this.serving;
    if (s) {
      if (s.semi === null) {
        if (t >= this.serviceEnd) this.serving = null;
      } else if (s.semi.st !== 'toPit' && s.semi.st !== 'unloading') {
        this.serving = null;
      }
    }
    if (!this.serving) {
      const next = this.entries.shift();
      if (next) {
        this.serving = next;
        if (next.semi === null) this.serviceEnd = t + next.serviceMin * MS.MIN;
        else next.semi.callToPit(next.serviceMin);
      }
    }
  }

  /** Lane position (arc length) a queued truck should creep up to. */
  laneTarget(semi: SemiActor): number {
    const idx = this.entries.findIndex((e) => e.semi === semi);
    const len = this.geo.lane.length;
    if (idx < 0) return len;
    return Math.max(0, len - TRUCK_SPACING_M * (idx + 1));
  }
}
