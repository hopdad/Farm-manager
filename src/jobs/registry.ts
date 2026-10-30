/**
 * src/jobs/registry.ts: one source for the local clock, the shop-PC worker and the Supabase
 * Cron SQL. All cron strings are UTC; `every` must be '1-59 seconds' (plan §1).
 *
 * Owner: the integrator. M1 one-line registry (docs/contracts-m1.md §1.1): the weather builder
 * adds exactly its import and its `weather.nws` entry (and that job's rows in registry.test.ts).
 * Consumers (the clock, /api/jobs/[name], jobs:emit-cron) import `registry`, which is typed
 * `JobRegistry` so `registry[name]` compiles while `jobs` is still empty, and must run
 * `validateRegistry(registry)` first.
 *
 *   fleet.trucks  every 30 s (plan §5 "Trucks: 30 s"), 25 s budget so runs never overlap;
 *                 5 s with JOBS_DEMO_CADENCE=on (plan §1 "5 s in local demo mode")
 *   fleet.deere   every 2 min (plan §1; the real cadence is set at 1f from Deere's call budget);
 *                 15 s with JOBS_DEMO_CADENCE=on (sim only: the stand-in has no call budget)
 *   weather.nws   every 30 min (plan §5 NWS); 30 s with JOBS_DEMO_CADENCE=on, so the sim's wind
 *                 slider shows on the board within seconds
 *   deere.fields  hourly at :17 (plan §1, §5 "Fields hourly"); 45 s in the demo (1f, deere-data:
 *                 fields, boundaries, flags → pins, equipment, engine hours)
 *   deere.ops     every 15 min (plan §5 "Operations every 15 min"); 20 s in the demo, so a field
 *                 the sim finishes shows its operation soon (1f, deere-ops)
 *
 * 1f.2 (docs/contracts-1f.md part B): one job per telematics connection, each on its own mode
 * key, all running at once (stubs in the builders' files until they land):
 *   fleet.motive     every 30 s, 5 s demo (Motive positions; trucks builder adds stats, faults)
 *   fleet.geotab     every 30 s, 10 s demo (MyGeotab GetFeed: GetFeed is limited to 60/min)
 *   fleet.equipment  every 60 s, 10 s demo (Samsara asset gateways; machines builder)
 *   fleet.aemp       every 15 min, 30 s demo (ISO 15143-3 snapshots, hourly at the OEM)
 *   fleet.cnh        every 5 min, 30 s demo (CNH FieldOps scaffolding)
 *   fleet.terminal   every 60 s, 15 s demo (Terminal; terminal-pickups)
 *   fleet.vehicles   hourly at :41, 60 s demo (vendor tags → vehicle kind; terminal-pickups)
 *
 * 1f (docs/contracts-1f.md §1): the foundation registered deere.fields and deere.ops with stub
 * run functions in the builders' own files (./deere-fields.ts, ./deere-ops.ts); the builders
 * replace the stubs and leave this file alone.
 *
 * `connector` names the mode each job talks through: the demo cadence only applies while that
 * connector is sim, replay or off (src/jobs/schedule.ts `demoCadenceApplies`).
 */
import { runDeereFields } from './deere-fields';
import { runDeereOps } from './deere-ops';
import { runFleetTrucks, TRUCKS_BUDGET_MS } from './fleet';
import { runFleetAemp } from './fleet-aemp';
import { runFleetCnh } from './fleet-cnh';
import { runFleetDeere } from './fleet-deere';
import { runFleetEquipment } from './fleet-equipment';
import { runFleetGeotab } from './fleet-geotab';
import { MOTIVE_BUDGET_MS, runFleetMotive } from './fleet-motive';
import { runFleetTerminal } from './fleet-terminal';
import { runFleetVehicles } from './fleet-vehicles';
import type { JobRegistry } from './types';
import { runWeatherNws } from './weather';

export const jobs = {
  'fleet.trucks': {
    every: '30 seconds',
    demoEvery: '5 seconds',
    budgetMs: TRUCKS_BUDGET_MS,
    connector: 'CONNECTOR_SAMSARA',
    run: runFleetTrucks,
  },
  'fleet.deere': {
    cron: '*/2 * * * *',
    demoEvery: '15 seconds',
    connector: 'CONNECTOR_DEERE',
    run: runFleetDeere,
  },
  'weather.nws': {
    cron: '*/30 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_WEATHER',
    run: runWeatherNws,
  },
  'deere.fields': {
    cron: '17 * * * *',
    demoEvery: '45 seconds',
    connector: 'CONNECTOR_DEERE',
    run: runDeereFields,
  },
  'deere.ops': {
    cron: '*/15 * * * *',
    demoEvery: '20 seconds',
    connector: 'CONNECTOR_DEERE',
    run: runDeereOps,
  },
  'fleet.motive': {
    every: '30 seconds',
    demoEvery: '5 seconds',
    budgetMs: MOTIVE_BUDGET_MS,
    connector: 'CONNECTOR_MOTIVE',
    run: runFleetMotive,
  },
  'fleet.geotab': {
    every: '30 seconds',
    demoEvery: '10 seconds',
    budgetMs: 25_000,
    connector: 'CONNECTOR_GEOTAB',
    run: runFleetGeotab,
  },
  'fleet.equipment': {
    cron: '* * * * *',
    demoEvery: '10 seconds',
    connector: 'CONNECTOR_SAMSARA',
    run: runFleetEquipment,
  },
  'fleet.aemp': {
    cron: '*/15 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_AEMP',
    run: runFleetAemp,
  },
  'fleet.cnh': {
    cron: '*/5 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_CNH',
    run: runFleetCnh,
  },
  'fleet.terminal': {
    cron: '* * * * *',
    demoEvery: '15 seconds',
    connector: 'CONNECTOR_TERMINAL',
    run: runFleetTerminal,
  },
  'fleet.vehicles': {
    cron: '41 * * * *',
    demoEvery: '59 seconds',
    connector: 'CONNECTOR_SAMSARA',
    run: runFleetVehicles,
  },
} satisfies JobRegistry;

/** The registry as a plain lookup table: `registry[name]` is `JobDef | undefined`. */
export const registry: JobRegistry = jobs;

/** Names of the registered jobs. */
export type JobName = keyof typeof jobs;
