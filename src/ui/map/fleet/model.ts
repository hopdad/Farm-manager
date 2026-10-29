/**
 * The board's fleet state (framework-free, unit-tested): snapshots from GET /api/fleet and
 * `fleet`/`tick` events from realtime, turned into per-frame positions that glide between fixes,
 * with staleness re-evaluated on a timer against the browser's wall clock (contracts §7: the
 * server's `stale` is only true at build time; the map owns "is it stale now").
 *
 *  - snapshot: authoritative set (machines missing from it are dropped)
 *  - tick: upsert; a fix older than the one already held is ignored (out-of-order delivery), and
 *    the same fix again (same `ts`, e.g. another job's full-fleet tick) leaves the glide alone
 *  - each new fix glides from the currently drawn position over the time between this machine's
 *    own last two fixes (two jobs publish full-fleet ticks at different cadences, so the gap
 *    between tick arrivals says nothing about one machine); jumps longer than `teleportMeters`
 *    snap. After a gap longer than `maxIntervalMs` (outage, idle Deere machine) the machine's
 *    last regular fix interval is used, else the arrival estimate.
 */
import { isMachineStale, type MachineView, type StaleThresholds } from '../../../domain/fleet';
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
  /** FLEET_STALE_SECONDS: ELD, cab-device and manual fixes. */
  staleAfterSeconds: number;
  /** FLEET_STALE_SECONDS_DEERE: Deere working-only fixes (default: staleAfterSeconds). */
  deereStaleAfterSeconds?: number;
  /** Glide length when a machine has no regular fix interval yet and two ticks haven't been seen. */
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
  /** Last gap between this machine's fixes that was within [0, maxIntervalMs], clamped; null until seen. */
  fixIntervalMs: number | null;
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
      deereStaleAfterSeconds: options.deereStaleAfterSeconds ?? options.staleAfterSeconds,
    };
    this.intervalMs = this.opts.defaultIntervalMs;
  }

  /** Estimated gap between tick arrivals (ms): the glide length of a machine's first glide. */
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

  private get thresholds(): StaleThresholds {
    return {
      staleAfterSeconds: this.opts.staleAfterSeconds,
      deereStaleAfterSeconds: this.opts.deereStaleAfterSeconds,
    };
  }

  private upsert(m: MachineView, now: number): void {
    const to: Fix = { lng: m.lng, lat: m.lat, heading: m.heading };
    const stale = isMachineStale(m, this.opts.wallNow(), this.thresholds);
    const prev = this.machines.get(m.id);
    if (!prev) {
      this.machines.set(m.id, { view: m, glide: stationary(to, now), stale, fixIntervalMs: null });
      return;
    }
    const ts = Date.parse(m.ts);
    const prevTs = Date.parse(prev.view.ts);
    if (ts < prevTs) return; // older fix: keep the newer one
    if (ts === prevTs) {
      // The same fix again (the other job's tick, a snapshot): keep gliding; status may change.
      this.machines.set(m.id, { ...prev, view: m, stale });
      return;
    }
    const { minIntervalMs: min, maxIntervalMs: max } = this.opts;
    const gap = ts - prevTs;
    const fixIntervalMs = gap <= max ? Math.max(min, gap) : prev.fixIntervalMs;
    const duration = gap <= max ? Math.max(min, gap) : (prev.fixIntervalMs ?? this.intervalMs);
    const from = glideAt(prev.glide, now);
    const moved = from.lng !== to.lng || from.lat !== to.lat || from.heading !== to.heading;
    const glide =
      !moved || distanceMeters(from, to) > this.opts.teleportMeters
        ? stationary(to, now)
        : { from, to, start: now, duration };
    this.machines.set(m.id, { view: m, glide, stale, fixIntervalMs });
  }

  /** Re-evaluate staleness against the wall clock. Returns true if any machine changed. */
  refreshStaleness(): boolean {
    const wall = this.opts.wallNow();
    let changed = false;
    for (const e of this.machines.values()) {
      const s = isMachineStale(e.view, wall, this.thresholds);
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
