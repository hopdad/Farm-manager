/**
 * Section-line roads: every grid line inside the demo extent is a road (rural Lenawee and Monroe
 * are close to that), N-S lines named "... Hwy" and E-W lines "... Rd". Nodes sit on section
 * corners plus every split point (field entrances, elevator yards, the shop), so routes start and
 * end exactly at those entrances. `Router` does Dijkstra on edge length.
 */
import { toGeoRef } from '../geo/georef';
import { localDistance, MILE_M } from '../geo/lnglat';
import { Path, type Vec } from '../geo/vec';
import type { LngLat, RoadEdge, RoadGraph, RoadNode } from '../types';
import { gridToLngLat } from './grid';
import { ROAD_NAMES } from './names';

/** A point that must become a node: on E-W line `j` at fractional gi, or N-S line `i` at gj. */
export type RoadSplit =
  | { nodeId: string; line: 'ew'; j: number; gi: number }
  | { nodeId: string; line: 'ns'; i: number; gj: number };

export interface RoadExtent {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

export const cornerNodeId = (i: number, j: number): string => `c:${i}:${j}`;

/** Coordinates are stored to 1e-8 degree (about 1 mm). */
export const roundLngLat = (p: LngLat): LngLat => [
  Math.round(p[0] * 1e8) / 1e8,
  Math.round(p[1] * 1e8) / 1e8,
];

/** Road name of a grid line (fixed by line index, independent of the seed). */
export function roadName(line: 'ew' | 'ns', index: number): string {
  const n = ROAD_NAMES.length;
  const k = line === 'ns' ? index : index + 17; // offset so crossing roads don't share names
  const base = ROAD_NAMES[((k % n) + n) % n] as string;
  return `${base} ${line === 'ns' ? 'Hwy' : 'Rd'}`;
}

/** Build the graph over corners i0..i1 x j0..j1, splitting edges at the given points. */
export function buildRoadGraph(extent: RoadExtent, splits: readonly RoadSplit[]): RoadGraph {
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const seen = new Set<string>();
  const addNode = (id: string, lngLat: LngLat) => {
    if (seen.has(id)) throw new Error(`duplicate road node ${id}`);
    seen.add(id);
    nodes.push({ id, lngLat: roundLngLat(lngLat) });
  };
  for (let j = extent.j0; j <= extent.j1; j++) {
    for (let i = extent.i0; i <= extent.i1; i++) addNode(cornerNodeId(i, j), gridToLngLat(i, j));
  }
  // Group splits by the base edge they fall on.
  const ewSplits = new Map<string, { id: string; t: number }[]>();
  const nsSplits = new Map<string, { id: string; t: number }[]>();
  for (const s of splits) {
    if (s.line === 'ew') {
      const i = Math.floor(s.gi);
      if (s.j < extent.j0 || s.j > extent.j1 || i < extent.i0 || i >= extent.i1) {
        throw new Error(`road split ${s.nodeId} is outside the road extent`);
      }
      const key = `${i}:${s.j}`;
      addNode(s.nodeId, gridToLngLat(s.gi, s.j));
      ewSplits.set(key, [...(ewSplits.get(key) ?? []), { id: s.nodeId, t: s.gi - i }]);
    } else {
      const j = Math.floor(s.gj);
      if (s.i < extent.i0 || s.i > extent.i1 || j < extent.j0 || j >= extent.j1) {
        throw new Error(`road split ${s.nodeId} is outside the road extent`);
      }
      const key = `${s.i}:${j}`;
      addNode(s.nodeId, gridToLngLat(s.i, s.gj));
      nsSplits.set(key, [...(nsSplits.get(key) ?? []), { id: s.nodeId, t: s.gj - j }]);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain = (ids: string[], name: string) => {
    for (let k = 0; k + 1 < ids.length; k++) {
      const a = byId.get(ids[k] as string) as RoadNode;
      const b = byId.get(ids[k + 1] as string) as RoadNode;
      const lengthMi = localDistance(a.lngLat, b.lngLat) / MILE_M;
      edges.push({ from: a.id, to: b.id, lengthMi: Math.round(lengthMi * 1e6) / 1e6, name });
    }
  };
  for (let j = extent.j0; j <= extent.j1; j++) {
    for (let i = extent.i0; i < extent.i1; i++) {
      const mid = (ewSplits.get(`${i}:${j}`) ?? []).sort((a, b) => a.t - b.t).map((s) => s.id);
      chain([cornerNodeId(i, j), ...mid, cornerNodeId(i + 1, j)], roadName('ew', j));
    }
  }
  for (let i = extent.i0; i <= extent.i1; i++) {
    for (let j = extent.j0; j < extent.j1; j++) {
      const mid = (nsSplits.get(`${i}:${j}`) ?? []).sort((a, b) => a.t - b.t).map((s) => s.id);
      chain([cornerNodeId(i, j), ...mid, cornerNodeId(i, j + 1)], roadName('ns', i));
    }
  }
  return { nodes, edges };
}

export interface Route {
  nodeIds: string[];
  lengthMi: number;
  /** The route in EPSG:3078 metres. */
  path: Path;
}

interface Adj {
  to: number;
  lengthMi: number;
}

/** Shortest paths on a RoadGraph (Dijkstra with a binary heap), with a route cache. */
export class Router {
  private readonly ids: string[];
  private readonly index = new Map<string, number>();
  private readonly adj: Adj[][];
  private readonly xy: Vec[];
  private readonly cache = new Map<string, Route>();

  constructor(graph: RoadGraph) {
    this.ids = graph.nodes.map((n) => n.id);
    graph.nodes.forEach((n, k) => {
      this.index.set(n.id, k);
    });
    this.xy = graph.nodes.map((n) => toGeoRef(n.lngLat[0], n.lngLat[1]));
    this.adj = graph.nodes.map(() => []);
    for (const e of graph.edges) {
      const a = this.index.get(e.from);
      const b = this.index.get(e.to);
      if (a === undefined || b === undefined)
        throw new Error(`edge ${e.from}-${e.to}: unknown node`);
      (this.adj[a] as Adj[]).push({ to: b, lengthMi: e.lengthMi });
      (this.adj[b] as Adj[]).push({ to: a, lengthMi: e.lengthMi });
    }
  }

  has(nodeId: string): boolean {
    return this.index.has(nodeId);
  }

  /** Position of a node in EPSG:3078. */
  nodeXY(nodeId: string): Vec {
    const k = this.index.get(nodeId);
    if (k === undefined) throw new Error(`unknown road node ${nodeId}`);
    return this.xy[k] as Vec;
  }

  route(fromId: string, toId: string): Route {
    const key = `${fromId}|${toId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const src = this.index.get(fromId);
    const dst = this.index.get(toId);
    if (src === undefined || dst === undefined) {
      throw new Error(`route ${fromId} -> ${toId}: unknown node`);
    }
    const n = this.ids.length;
    const distArr = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    const prev = new Int32Array(n).fill(-1);
    distArr[src] = 0;
    const heap = new MinHeap();
    heap.push(src, 0);
    while (heap.size) {
      const [u, du] = heap.pop();
      if (du > (distArr[u] as number)) continue;
      if (u === dst) break;
      for (const e of this.adj[u] as Adj[]) {
        const nd = du + e.lengthMi;
        if (nd < (distArr[e.to] as number)) {
          distArr[e.to] = nd;
          prev[e.to] = u;
          heap.push(e.to, nd);
        }
      }
    }
    if (!Number.isFinite(distArr[dst] as number)) {
      throw new Error(`no road route ${fromId} -> ${toId}`);
    }
    const order: number[] = [];
    for (let k = dst; k !== -1; k = prev[k] as number) order.push(k);
    order.reverse();
    const route: Route = {
      nodeIds: order.map((k) => this.ids[k] as string),
      lengthMi: distArr[dst] as number,
      path: new Path(order.map((k) => this.xy[k] as Vec)),
    };
    this.cache.set(key, route);
    return route;
  }
}

class MinHeap {
  private readonly keys: number[] = [];
  private readonly prios: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, prio: number): void {
    this.keys.push(key);
    this.prios.push(prio);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.prios[p] as number) <= prio) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0] as number, this.prios[0] as number];
    const lastKey = this.keys.pop() as number;
    const lastPrio = this.prios.pop() as number;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && (this.prios[l] as number) < (this.prios[m] as number)) m = l;
        if (r < this.keys.length && (this.prios[r] as number) < (this.prios[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
    [this.prios[a], this.prios[b]] = [this.prios[b] as number, this.prios[a] as number];
  }
}
