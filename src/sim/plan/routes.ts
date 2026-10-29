/**
 * Trips between places: out of the current place (field gate, shop gate, elevator exit loop),
 * along the section-line road graph, and into the destination. Everything off the road graph is
 * a short driveway / in-field / in-yard leg, so "in transport and off the road" only ever happens
 * inside a field, a yard, or within a road right-of-way.
 */
import type { Activity } from '../../domain/fleet';
import { Path, type Vec } from '../geo/vec';
import { type Leg, Trip } from './agent';
import type { DayContext } from './context';

export type Place =
  | { kind: 'shop' }
  | { kind: 'field'; idx: number }
  /** On a field's approach (road shoulder at the entrance, outside the boundary): staged trucks. */
  | { kind: 'approach'; idx: number }
  | { kind: 'elevator'; idx: number };

export interface Speeds {
  /** In-field / in-yard metres per second. */
  local: number;
  /** Road metres per second. */
  road: number;
}

const leg = (pts: Vec[], mps: number, act: Activity, field: number): Leg => ({
  path: new Path(pts),
  mps,
  act,
  field,
});

function nodeOf(ctx: DayContext, place: Place): string {
  if (place.kind === 'shop') return ctx.farm.shop.nodeId;
  if (place.kind === 'field' || place.kind === 'approach') {
    return (ctx.fields[place.idx] ?? fail('field')).field.entranceNodeId;
  }
  return (ctx.elevators[place.idx] ?? fail('elevator')).elevator.entranceNodeId;
}

function fail(what: string): never {
  throw new Error(`unknown ${what} in trip`);
}

/** Legs from `pos` inside `place` out to its road node. */
function exitLegs(ctx: DayContext, place: Place, pos: Vec, s: Speeds): Leg[] {
  if (place.kind === 'shop') {
    return [
      leg([pos, ctx.shop.gate], s.local, 'transport', -1),
      leg([ctx.shop.gate, ctx.shop.entrance], s.local, 'transport', -1),
    ];
  }
  if (place.kind === 'field') {
    const f = ctx.fields[place.idx] ?? fail('field');
    return [
      leg([pos, f.gate], s.local, 'transport', f.idx),
      leg([f.gate, f.entrance], s.local, 'transport', -1),
    ];
  }
  if (place.kind === 'approach') {
    const f = ctx.fields[place.idx] ?? fail('field');
    return [leg([pos, f.entrance], s.local, 'transport', -1)];
  }
  const e = ctx.elevators[place.idx] ?? fail('elevator');
  // Leaving from the pit around the exit loop (pos is the pit when a truck leaves).
  return [{ path: e.outPath, mps: s.local, act: 'transport', field: -1 }];
}

/** Legs from the destination's road node to `point` inside it. */
function enterLegs(ctx: DayContext, place: Place, point: Vec, s: Speeds): Leg[] {
  if (place.kind === 'shop') {
    return [
      leg([ctx.shop.entrance, ctx.shop.gate], s.local, 'transport', -1),
      leg([ctx.shop.gate, point], s.local, 'transport', -1),
    ];
  }
  if (place.kind === 'field') {
    const f = ctx.fields[place.idx] ?? fail('field');
    return [
      leg([f.entrance, f.gate], s.local, 'transport', -1),
      leg([f.gate, point], s.local, 'transport', f.idx),
    ];
  }
  if (place.kind === 'approach') {
    const f = ctx.fields[place.idx] ?? fail('field');
    return [leg([f.entrance, point], s.local, 'transport', -1)];
  }
  const e = ctx.elevators[place.idx] ?? fail('elevator');
  return [{ path: e.inPath, mps: s.local, act: 'transport', field: -1 }];
}

const samePlace = (a: Place, b: Place) =>
  a.kind === b.kind &&
  (a.kind === 'shop' || (a as { idx: number }).idx === (b as { idx: number }).idx);

/**
 * A trip from `pos` in `from` to `point` in `to`. Within one field or yard it is a straight
 * local leg; from a field's approach into that field it is the entrance driveway; otherwise
 * exit, road route (shortest by length), enter. Loaded trucks pass a slower `s.road`.
 */
export function tripBetween(
  ctx: DayContext,
  from: Place,
  pos: Vec,
  to: Place,
  point: Vec,
  s: Speeds,
): Trip {
  if (samePlace(from, to) && to.kind !== 'elevator') {
    return new Trip([leg([pos, point], s.local, 'transport', to.kind === 'field' ? to.idx : -1)]);
  }
  if (from.kind === 'approach' && to.kind === 'field' && from.idx === to.idx) {
    return new Trip(enterLegs(ctx, to, point, s).filter((l) => l.path.length > 1e-6));
  }
  const legs = exitLegs(ctx, from, pos, s);
  const a = nodeOf(ctx, from);
  const b = nodeOf(ctx, to);
  if (a !== b) {
    legs.push({ path: ctx.router.route(a, b).path, mps: s.road, act: 'transport', field: -1 });
  }
  legs.push(...enterLegs(ctx, to, point, s));
  return new Trip(legs.filter((l) => l.path.length > 1e-6));
}

/** Road miles between two places' road nodes. */
export function roadMiles(ctx: DayContext, from: Place, to: Place): number {
  const a = nodeOf(ctx, from);
  const b = nodeOf(ctx, to);
  return a === b ? 0 : ctx.router.route(a, b).lengthMi;
}
