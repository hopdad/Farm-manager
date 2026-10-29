/**
 * Simulator entry point (contracts §9). The vendor stand-in, the demo seed and the tests use:
 *
 *   buildSimFarm(seed?)                  the deterministic demo farm (depends only on the seed)
 *   createSimWorld({ scenario, seed? })  farm + scenario: world.machineAt(machineId, simTime)
 *   createSimClock / applyClockControl   the time rule: sim time advances, timestamps are wall
 *
 * See ./types.ts for the contract and the time rule. Everything here is pure TypeScript with
 * no database, network or filesystem access, so the stand-in and the tests can import it.
 */
import { buildDemoFarm, DEFAULT_SIM_SEED } from './farm/build';
import type { BuildSimFarm, CreateSimWorld } from './types';
import { createDemoWorld } from './world';

export * from './types';

export const buildSimFarm: BuildSimFarm = (seed = DEFAULT_SIM_SEED) => buildDemoFarm(seed);

export const createSimWorld: CreateSimWorld = (opts) => createDemoWorld(opts);

export {
  applyClockControl,
  clockStatus,
  createSimClock,
  initialClockState,
  MAX_SIM_SPEED,
  reanchor,
} from './clock';
export {
  buildDemoFarm,
  DEFAULT_SIM_SEED,
  type DemoFarm,
  type SimBinSite,
  type SimFieldMeta,
  TOWNS,
} from './farm/build';
export { FLEET, type FleetSpec } from './farm/fleet';
export { Router } from './farm/roads';
export { fromGeoRef, GEOREF_SRID, toGeoRef } from './geo/georef';
export { SCENARIOS, scenarioStartsAt } from './scenarios';
export {
  CURRENT_CROP_YEAR,
  cropFor,
  SEASON_YEARS,
  type SimFieldSeason,
  simFieldSeasons,
} from './seasons';
export {
  createDemoWorld,
  type DemoWorld,
  type DemoWorldOptions,
  HORIZON_DAYS,
  type SimDayReport,
  type SimLoadReport,
  type SimWorkReport,
} from './world';
