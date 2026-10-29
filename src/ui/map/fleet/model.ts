/**
 * The board's fleet state (framework-free, unit-tested): snapshots from GET /api/fleet and
 * `fleet`/`tick` events from realtime, turned into per-frame positions that glide between fixes,
 * with staleness re-evaluated on a timer against the browser's wall clock (contracts §7: the
 * server's `stale` is only true at build time; the map owns "is it stale now").
 *
 *  - snapshot: authoritative set (machines missing from it are dropped)
 *  - tick: upsert; a fix older than the one already held is ignored (out-of-order delivery)
 *  - each new fix glides from the currently drawn position over the estimated tick interval;
 *    jumps longer than `teleportMeters` snap
 */
import { isStale, type MachineView } from '../../../domain/fleet';
import {
  distanceMeters,
  type Fix,
  type Glide,
  glideAt,
  isGliding,
  nextIntervalEstimate,
  stationary,
} from './glide';

export interface FleetModelOptions {
  staleAfterSeconds: number;
  /** Glide length before two ticks have been seen. */
  defaultIntervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Fixes further than this from the drawn position snap instead of gliding. */
  teleportMeters?: number;
  /** Browser wall clock (tests inject one). */
  wallNow?: () => Date;
}

interface Entry {
  view: MachineView;
  glide: Glide;
  stale: boolean;
}

/** One machine as drawn in a frame. */
export interface FleetFrame {
  id: string;
  unitNo: string;
  kind: MachineView['kind'];
  activity: MachineView['activity'];
  status: MachineView['status'];
  positionSource: MachineView['positionSource'];
  speedMph: number;
  ts: string;
  /** Interpolated position (WGS84) and heading for this frame. */
  lng: number;
  lat: number;
  heading: number;
  /** Re-evaluated against the browser clock (see refreshStaleness). */
  stale: boolean;
}

export interface FleetCounts {
  total: number;
  stale: number;
  down: number;
}

export class FleetModel {
  private readonly machines = new Map<string, Entry>();
  private readonly opts: Required<Omit<FleetModelOptions, 'wallNow'>> & {
    wallNow: () => Date;
  };
  private intervalMs: number;
  private lastTickAt: number | null = null;
  /** Bumped on every change that affects counts or the list (not on animation). */
  version = 0;

  constructor(options: FleetModelOptions) {
    this.opts = {
      defaultIntervalMs: 5_000,
      minIntervalMs: 1_000,
      maxIntervalMs: 30_000,
      teleportMeters: 5_000,
      wallNow: () => new Date(),
      ...options,
    };
    this.intervalMs = this.opts.defaultIntervalMs;
  }

  /** Current glide length (ms). */
  get tickIntervalMs(): number {
    return this.intervalMs;
  }

  get size(): number {
    return this.machines.size;
  }

  /** Replace the fleet with a snapshot (GET /api/fleet). */
  applySnapshot(machines: readonly MachineView[], now: number): void {
    const ids = new Set(machines.map((m) => m.id));
    for (const id of [...this.machines.keys()]) if (!ids.has(id)) this.machines.delete(id);
    for (const m of machines) this.upsert(m, now);
    this.version++;
  }

  /** Apply a realtime tick: upsert every machine it carries. */
  applyTick(machines: readonly MachineView[], now: number): void {
    if (this.lastTickAt !== null) {
      this.intervalMs = nextIntervalEstimate(
        this.intervalMs,
        now - this.lastTickAt,
        this.opts.minIntervalMs,
        this.opts.maxIntervalMs,
      );
    }
    this.lastTickAt = now;
    for (const m of machines) this.upsert(m, now);
    this.version++;
  }

  private upsert(m: MachineView, now: number): void {
    const to: Fix = { lng: m.lng, lat: m.lat, heading: m.heading };
    const stale = isStale(m.ts, this.opts.wallNow(), this.opts.staleAfterSeconds);
    const prev = this.machines.get(m.id);
    if (!prev) {
      this.machines.set(m.id, { view: m, glide: stationary(to, now), stale });
      return;
    }
    if (Date.parse(m.ts) < Date.parse(prev.view.ts)) return; // older fix: keep the newer one
    const from = glideAt(prev.glide, now);
    const moved = from.lng !== to.lng || from.lat !== to.lat || from.heading !== to.heading;
    const glide =
      !moved || distanceMeters(from, to) > this.opts.teleportMeters
        ? stationary(to, now)
        : { from, to, start: now, duration: this.intervalMs };
    this.machines.set(m.id, { view: m, glide, stale });
  }

  /** Re-evaluate staleness against the wall clock. Returns true if any machine changed. */
  refreshStaleness(): boolean {
    const wall = this.opts.wallNow();
    let changed = false;
    for (const e of this.machines.values()) {
      const s = isStale(e.view.ts, wall, this.opts.staleAfterSeconds);
      if (s !== e.stale) {
        e.stale = s;
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  /** Is any machine still gliding at `now`? (The render loop idles otherwise.) */
  isAnimating(now: number): boolean {
    for (const e of this.machines.values()) if (isGliding(e.glide, now)) return true;
    return false;
  }

  /** Every machine at `now`, sorted by unit number (stable draw order). */
  frame(now: number): FleetFrame[] {
    const out: FleetFrame[] = [];
    for (const e of this.machines.values()) {
      const p = glideAt(e.glide, now);
      const v = e.view;
      out.push({
        id: v.id,
        unitNo: v.unitNo,
        kind: v.kind,
        activity: v.activity,
        status: v.status,
        positionSource: v.positionSource,
        speedMph: v.speedMph,
        ts: v.ts,
        lng: p.lng,
        lat: p.lat,
        heading: p.heading,
        stale: e.stale,
      });
    }
    return out.sort((a, b) => a.unitNo.localeCompare(b.unitNo, 'en', { numeric: true }));
  }

  counts(): FleetCounts {
    let stale = 0;
    let down = 0;
    for (const e of this.machines.values()) {
      if (e.stale) stale++;
      if (e.view.status === 'down') down++;
    }
    return { total: this.machines.size, stale, down };
  }
}
