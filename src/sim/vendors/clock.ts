/**
 * The stand-in's sim clock (contracts §9 "the time rule"), as a TIMELINE of clock segments.
 *
 * Every clock change (pause, resume, speed, jump, freeze, reset) re-anchors at the current wall
 * time and appends a segment, so a feed page that covers wall instants from before a change
 * samples each instant with the clock that was in effect at that instant: pausing at wall P
 * and serving the backlog later still shows the machines moving up to P and frozen after it.
 * The latest segment is the current `SimClockState`; the normative arithmetic is
 * `wallToSim()` from src/sim/types.ts.
 *
 * Pure (no I/O); the server persists the timeline in .data/vendor-sim/state.json.
 */
import {
  type ClockControlRequest,
  type SimClock,
  type SimClockState,
  type SimClockStatus,
  wallToSim,
} from '../types';

/** Segments kept (oldest dropped first); plenty for a day of demo clicking. */
export const MAX_CLOCK_SEGMENTS = 200;
export const MAX_SIM_SPEED = 3600;

export type ClockTimeline = SimClockState[];

export class ClockRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockRequestError';
  }
}

/** A fresh timeline anchored at `simStart` (reset / scenario switch). */
export function startTimeline(
  simStart: Date,
  wallNow: Date,
  opts: { speed?: number; paused?: boolean } = {},
): ClockTimeline {
  return [
    {
      anchorWall: wallNow.toISOString(),
      anchorSim: simStart.toISOString(),
      speed: checkSpeed(opts.speed ?? 1),
      paused: opts.paused ?? false,
    },
  ];
}

function checkSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0 || speed > MAX_SIM_SPEED) {
    throw new ClockRequestError(`speed must be > 0 and <= ${MAX_SIM_SPEED}`);
  }
  return speed;
}

function checkIso(value: string, what: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ClockRequestError(`${what} must be an ISO date-time`);
  return new Date(t).toISOString();
}

/** The current clock state (last segment). */
export function currentClock(timeline: ClockTimeline): SimClockState {
  const last = timeline[timeline.length - 1];
  if (!last) throw new Error('clock timeline is empty');
  return last;
}

/**
 * Sim time at a wall instant, using the segment in effect at that instant (the latest one
 * anchored at or before it). Instants before the first segment extrapolate from it.
 */
export function simAt(timeline: ClockTimeline, wall: Date): Date {
  const w = wall.getTime();
  let seg = timeline[0];
  if (!seg) throw new Error('clock timeline is empty');
  for (let i = timeline.length - 1; i >= 0; i--) {
    const s = timeline[i] as SimClockState;
    if (Date.parse(s.anchorWall) <= w) {
      seg = s;
      break;
    }
  }
  return wallToSim(seg, wall);
}

/** Apply one control request at `wallNow` (re-anchors) and return the new timeline. */
export function applyClockRequest(
  timeline: ClockTimeline,
  req: ClockControlRequest,
  wallNow: Date,
): ClockTimeline {
  const cur = currentClock(timeline);
  const simNow = wallToSim(cur, wallNow).toISOString();
  const anchorWall = wallNow.toISOString();
  let next: SimClockState;
  switch (req.action) {
    case 'pause':
      next = { anchorWall, anchorSim: simNow, speed: cur.speed, paused: true };
      break;
    case 'resume':
      next = { anchorWall, anchorSim: simNow, speed: cur.speed, paused: false };
      break;
    case 'speed':
      next = { anchorWall, anchorSim: simNow, speed: checkSpeed(req.speed), paused: cur.paused };
      break;
    case 'jump':
      next = {
        anchorWall,
        anchorSim: checkIso(req.simTime, 'simTime'),
        speed: cur.speed,
        paused: cur.paused,
      };
      break;
    case 'freeze':
      next = {
        anchorWall,
        anchorSim: checkIso(req.simTime, 'simTime'),
        speed: cur.speed,
        paused: true,
      };
      break;
    default: {
      const never: never = req;
      throw new ClockRequestError(`unknown clock action ${JSON.stringify(never)}`);
    }
  }
  // Two changes in the same millisecond: the later one replaces the earlier segment.
  const kept = timeline.filter((s) => Date.parse(s.anchorWall) < wallNow.getTime());
  return [...kept, next].slice(-MAX_CLOCK_SEGMENTS);
}

/** GET /_control/clock body. */
export function clockStatus(timeline: ClockTimeline, wallNow: Date): SimClockStatus {
  const cur = currentClock(timeline);
  return {
    ...cur,
    simNow: wallToSim(cur, wallNow).toISOString(),
    wallNow: wallNow.toISOString(),
  };
}

/** A read-only `SimClock` view of the current segment (contracts §9). */
export function simClockOf(timeline: ClockTimeline): SimClock {
  const cur = currentClock(timeline);
  return {
    wallToSim: (wall: Date) => simAt(timeline, wall),
    paused: cur.paused,
    speed: cur.speed,
  };
}
