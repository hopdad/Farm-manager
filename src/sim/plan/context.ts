/**
 * Everything a day planner needs, precomputed once per world in EPSG:3078 metres: field rings,
 * entrances, staging slots for trucks, where carts dump and machines park, the shop's parking
 * slots, and each elevator yard's lane (queue), pit and exit loop.
 */
import { type DemoFarm, ELEVATOR_YARD, ROAD_SIDE_INSET_M, SHOP_YARD } from '../farm/build';
import { FLEET, type FleetSpec } from '../farm/fleet';
import { Router } from '../farm/roads';
import { toGeoRef } from '../geo/georef';
import { offsetLngLat } from '../geo/lnglat';
import { add, along, dist, norm, Path, sub, type Vec } from '../geo/vec';
import type { LngLat, SimElevator, SimField, SimMachine } from '../types';
import { type Coverage, planCoverage } from './coverage';

const xy = (p: LngLat): Vec => toGeoRef(p[0], p[1]);

/** EPSG:3078 unit vector of a local (east, north) direction at p. */
function dirAt(p: LngLat, east: number, north: number): Vec {
  return norm(sub(xy(offsetLngLat(p, east * 10, north * 10)), xy(p)));
}

export interface FieldGeo {
  idx: number;
  field: SimField;
  ring: Vec[];
  /** On the road centreline. */
  entrance: Vec;
  /** Unit vectors: from the road into the field, and along the road. */
  inward: Vec;
  alongRoad: Vec;
  /** Just inside the boundary, opposite the entrance. */
  gate: Vec;
  centroid: Vec;
  coverage(widthM: number): Coverage;
  /** Truck staging slot k (0 = being loaded), on the field approach outside the boundary. */
  slot(k: number): Vec;
  /** Where the grain cart stops (just inside the field edge) to dump into the truck in slot 0. */
  dumpSpot: Vec;
  /** Overnight / hold parking spot k. */
  parkSpot(k: number): Vec;
}

export interface ShopGeo {
  entrance: Vec;
  gate: Vec;
  ring: Vec[];
  /** Parking slot of machine idx. */
  slot(machineIdx: number): Vec;
  /** Grid heading machines park at (facing the road). */
  parkHeading: number;
}

export interface ElevatorGeo {
  idx: number;
  elevator: SimElevator;
  entrance: Vec;
  ring: Vec[];
  /** Entrance -> start of the queue lane. */
  inPath: Path;
  /** The queue lane; the pit is at its end. */
  lane: Path;
  /** Pit -> back to the entrance (on the road). */
  outPath: Path;
}

export interface MachineInfo {
  idx: number;
  machine: SimMachine;
  spec: FleetSpec;
}

export interface DayContext {
  farm: DemoFarm;
  router: Router;
  fields: FieldGeo[];
  fieldIndex: Map<string, number>;
  shop: ShopGeo;
  elevators: ElevatorGeo[];
  machines: MachineInfo[];
  machineIndex: Map<string, number>;
}

/** Spacing between queued trucks in a lane / staged trucks at a field. */
export const TRUCK_SPACING_M = 22;
/** Staged trucks stand this far from the road centreline (shoulder / field approach). */
export const TRUCK_SHOULDER_M = 9;

function ringOf(coords: readonly (readonly number[])[]): Vec[] {
  const pts = coords.map((c) => xy([c[0] as number, c[1] as number]));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && dist(first, last) < 1e-6) pts.pop();
  return pts;
}

function fieldGeo(field: SimField, idx: number): FieldGeo {
  const ring = ringOf(field.boundary.coordinates[0]?.[0] ?? []);
  const entrance = xy(field.entrance);
  const centroid = ring.reduce((s, p) => add(s, { x: p.x / ring.length, y: p.y / ring.length }), {
    x: 0,
    y: 0,
  });
  // Inward = from the entrance toward the field, snapped to the nearest cardinal direction
  // (the entrance is on a N-S or E-W section line).
  const c = sub(centroid, entrance);
  const eastPart = dirAt(field.entrance, 1, 0);
  const northPart = dirAt(field.entrance, 0, 1);
  const de = c.x * eastPart.x + c.y * eastPart.y;
  const dn = c.x * northPart.x + c.y * northPart.y;
  const inward =
    Math.abs(de) > Math.abs(dn)
      ? dirAt(field.entrance, Math.sign(de), 0)
      : dirAt(field.entrance, 0, Math.sign(dn));
  const alongRoad = { x: inward.y, y: -inward.x };
  const coverages = new Map<number, Coverage>();
  // Trucks stage on the field approach, on the road shoulder outside the boundary.
  const slotBase = along(entrance, inward, TRUCK_SHOULDER_M);
  const slots: Vec[] = [];
  return {
    idx,
    field,
    ring,
    entrance,
    inward,
    alongRoad,
    gate: along(entrance, inward, ROAD_SIDE_INSET_M + 1),
    centroid,
    coverage(widthM) {
      const key = Math.round(widthM * 1000);
      let cov = coverages.get(key);
      if (!cov) {
        cov = planCoverage(ring, entrance, widthM);
        coverages.set(key, cov);
      }
      return cov;
    },
    slot(k) {
      let p = slots[k];
      if (!p) {
        const side = k === 0 ? 0 : k % 2 === 1 ? Math.ceil(k / 2) : -Math.ceil(k / 2);
        p = along(slotBase, alongRoad, side * TRUCK_SPACING_M);
        slots[k] = p;
      }
      return p;
    },
    dumpSpot: along(entrance, inward, ROAD_SIDE_INSET_M + 3),
    parkSpot(k) {
      return along(along(entrance, inward, ROAD_SIDE_INSET_M + 40), alongRoad, -36 + k * 16);
    },
  };
}

function shopGeo(farm: DemoFarm): ShopGeo {
  const entranceLL = farm.roads.nodes.find((n) => n.id === farm.shop.nodeId)?.lngLat;
  if (!entranceLL) throw new Error('shop node missing from the road graph');
  const entrance = xy(entranceLL);
  const ring = ringOf(farm.shop.geofence.coordinates[0] ?? []);
  // Away from the road: toward the yard's centre.
  const centre = xy(farm.shop.location);
  const north = dirAt(entranceLL, 0, 1);
  const away = (centre.x - entrance.x) * north.x + (centre.y - entrance.y) * north.y > 0 ? 1 : -1;
  const awayVec = dirAt(entranceLL, 0, away);
  const alongVec = dirAt(entranceLL, 1, 0);
  const [u0, , w0] = SHOP_YARD;
  return {
    entrance,
    gate: along(entrance, awayVec, w0 + 2),
    ring,
    slot(i) {
      const col = i % 6;
      const row = Math.floor(i / 6);
      return along(along(entrance, alongVec, u0 + 20 + col * 18), awayVec, w0 + 30 + row * 32);
    },
    parkHeading: away > 0 ? 180 : 0,
  };
}

function elevatorGeo(e: SimElevator, idx: number): ElevatorGeo {
  const entrance = xy(e.entrance);
  const ring = ringOf(e.geofence.coordinates[0] ?? []);
  const centre = ring.reduce((s, p) => add(s, { x: p.x / ring.length, y: p.y / ring.length }), {
    x: 0,
    y: 0,
  });
  const north = dirAt(e.entrance, 0, 1);
  const away = (centre.x - entrance.x) * north.x + (centre.y - entrance.y) * north.y > 0 ? 1 : -1;
  const awayVec = dirAt(e.entrance, 0, away);
  const alongVec = dirAt(e.entrance, 1, 0);
  const [u0, u1, w0, w1] = ELEVATOR_YARD;
  const at = (u: number, w: number) => along(along(entrance, alongVec, u), awayVec, w);
  const laneW = w0 + 18;
  const backW = w1 - 30;
  const pitU = u1 - 45;
  return {
    idx,
    elevator: e,
    entrance,
    ring,
    inPath: new Path([entrance, at(0, w0 + 2), at(0, laneW)]),
    lane: new Path([at(0, laneW), at(pitU, laneW)]),
    outPath: new Path([
      at(pitU, laneW),
      at(u1 - 15, laneW),
      at(u1 - 15, backW),
      at(u0 + 20, backW),
      at(u0 + 20, w0 + 2),
      at(u0 + 20, 0),
      entrance,
    ]),
  };
}

export function buildContext(farm: DemoFarm): DayContext {
  const fields = farm.fields.map((f, i) => fieldGeo(f, i));
  const machines = farm.machines.map((m, idx) => {
    const spec = FLEET.find((f) => f.key === m.key);
    if (!spec) throw new Error(`no fleet spec for ${m.key}`);
    return { idx, machine: m, spec };
  });
  return {
    farm,
    router: new Router(farm.roads),
    fields,
    fieldIndex: new Map(farm.fields.map((f, i) => [f.id, i])),
    shop: shopGeo(farm),
    elevators: farm.elevators.map((e, i) => elevatorGeo(e, i)),
    machines,
    machineIndex: new Map(farm.machines.map((m, i) => [m.id, i])),
  };
}
