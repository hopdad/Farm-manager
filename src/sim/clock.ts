/**
 * The sim clock (contracts §9, "the time rule"): the world advances in SIM time, every
 * timestamp the stand-in reports is WALL time. State is { anchorWall, anchorSim, speed, paused }
 * and the arithmetic is `wallToSim` from ./types (normative). Every change re-anchors at the
 * current wall time, so pausing freezes sim time exactly where it is and a speed change never
 * jumps it.
 *
 * Pure functions; the stand-in owns the state and persists it (.data/vendor-sim/state.json).
 */
import {
  type ClockControlRequest,
  type SimClock,
  type SimClockState,
  type SimClockStatus,
  wallToSim,
} from './types';

/** Same bounds as config SIM_SPEED. */
export const MAX_SIM_SPEED = 3600;

function checkSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0 || speed > MAX_SIM_SPEED) {
    throw new RangeError(`sim speed must be > 0 and <= ${MAX_SIM_SPEED} (got ${speed})`);
  }
  return speed;
}

function checkInstant(iso: string, what: string): Date {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`${what} is not an ISO instant: ${iso}`);
  return new Date(ms);
}

/** A read-only SimClock over a state. */
export function createSimClock(state: SimClockState): SimClock {
  const frozen = { ...state };
  return {
    wallToSim: (wall: Date) => wallToSim(frozen, wall),
    paused: frozen.paused,
    speed: frozen.speed,
  };
}

/**
 * The state at boot or after a reset: sim time = `startsAt` at `wallNow`, running at `speed`;
 * with `frozenAt` (SIM_FROZEN_AT) it is paused there instead.
 */
export function initialClockState(opts: {
  startsAt: Date;
  wallNow: Date;
  speed?: number;
  frozenAt?: Date | null;
}): SimClockState {
  const speed = checkSpeed(opts.speed ?? 1);
  const at = opts.frozenAt ?? opts.startsAt;
  return {
    anchorWall: opts.wallNow.toISOString(),
    anchorSim: at.toISOString(),
    speed,
    paused: Boolean(opts.frozenAt),
  };
}

/** Re-anchor at `wallNow` without changing behaviour. */
export function reanchor(state: SimClockState, wallNow: Date): SimClockState {
  return {
    ...state,
    anchorWall: wallNow.toISOString(),
    anchorSim: wallToSim(state, wallNow).toISOString(),
  };
}

/** Apply a POST /_control/clock request at `wallNow`. Throws RangeError for bad input. */
export function applyClockControl(
  state: SimClockState,
  req: ClockControlRequest,
  wallNow: Date,
): SimClockState {
  const here = reanchor(state, wallNow);
  switch (req.action) {
    case 'pause':
      return { ...here, paused: true };
    case 'resume':
      return { ...here, paused: false };
    case 'speed':
      return { ...here, speed: checkSpeed(req.speed) };
    case 'jump':
      return { ...here, anchorSim: checkInstant(req.simTime, 'simTime').toISOString() };
    case 'freeze':
      return {
        ...here,
        anchorSim: checkInstant(req.simTime, 'simTime').toISOString(),
        paused: true,
      };
    default: {
      const action = (req as { action?: unknown }).action;
      throw new RangeError(`unknown clock action '${String(action)}'`);
    }
  }
}

/** GET /_control/clock body. */
export function clockStatus(state: SimClockState, wallNow: Date): SimClockStatus {
  return {
    ...state,
    simNow: wallToSim(state, wallNow).toISOString(),
    wallNow: wallNow.toISOString(),
  };
}
