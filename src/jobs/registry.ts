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
 * 2a (docs/contracts-2a.md §7.7):
 *   usage.prune      daily at 07:23 UTC (night in Michigan): app.usage_events older than 400
 *                    days (rights-usage; a stub until it lands); no demo cadence, no connector
 *
 * 1f (docs/contracts-1f.md §1): the foundation registered deere.fields and deere.ops with stub
 * run functions in the builders' own files (./deere-fields.ts, ./deere-ops.ts); the builders
 * replace the stubs and leave this file alone.
 *
 * `connector` names the mode each job talks through: the demo cadence only applies while that
 * connector is sim, replay or off (src/jobs/schedule.ts `demoCadenceApplies`). `streams` names
 * the sync_state streams of that connector's source the job runs (/admin/connectors judges each
 * against its own job's schedule).
 */
import { DEERE_FIELDS_STREAMS } from '../connectors/deere/fields/sync';
import { runDeereFields } from './deere-fields';
import { DEERE_OPS_STREAM, runDeereOps } from './deere-ops';
import {
  FAULTS_STREAM,
  runFleetTrucks,
  STATS_STREAM,
  TRUCKS_BUDGET_MS,
  TRUCKS_STREAM,
} from './fleet';
import { AEMP_FAULTS_STREAM, AEMP_FLEET_STREAM, runFleetAemp } from './fleet-aemp';
import {
  CNH_FAULTS_STREAM,
  CNH_FLEET_STREAM,
  CNH_POSITIONS_STREAM,
  runFleetCnh,
} from './fleet-cnh';
import { DEERE_STREAM, runFleetDeere } from './fleet-deere';
import {
  EQUIPMENT_POSITIONS_STREAM,
  EQUIPMENT_STATS_STREAM,
  runFleetEquipment,
} from './fleet-equipment';
import {
  GEOTAB_FAULTS_STREAM,
  GEOTAB_POSITIONS_STREAM,
  GEOTAB_STATS_STREAM,
  GEOTAB_VEHICLES_STREAM,
  runFleetGeotab,
} from './fleet-geotab';
import {
  MOTIVE_BUDGET_MS,
  MOTIVE_FAULTS_STREAM,
  MOTIVE_POSITIONS_STREAM,
  MOTIVE_STATS_STREAM,
  MOTIVE_VEHICLES_STREAM,
  runFleetMotive,
} from './fleet-motive';
import {
  runFleetTerminal,
  TERMINAL_FAULTS_STREAM,
  TERMINAL_POSITIONS_STREAM,
  TERMINAL_PROVIDERS_STREAM,
  TERMINAL_STATS_STREAM,
  TERMINAL_VEHICLES_STREAM,
} from './fleet-terminal';
import { runFleetVehicles, VEHICLES_STREAM } from './fleet-vehicles';
import type { JobRegistry } from './types';
import { runUsagePrune } from './usage-prune';
import { FORECAST_STREAM, OBSERVATIONS_STREAM, runWeatherNws } from './weather';

export const jobs = {
  'fleet.trucks': {
    every: '30 seconds',
    demoEvery: '5 seconds',
    budgetMs: TRUCKS_BUDGET_MS,
    connector: 'CONNECTOR_SAMSARA',
    streams: [TRUCKS_STREAM, STATS_STREAM, FAULTS_STREAM],
    run: runFleetTrucks,
  },
  'fleet.deere': {
    cron: '*/2 * * * *',
    demoEvery: '15 seconds',
    connector: 'CONNECTOR_DEERE',
    streams: [DEERE_STREAM],
    run: runFleetDeere,
  },
  'weather.nws': {
    cron: '*/30 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_WEATHER',
    streams: [FORECAST_STREAM, OBSERVATIONS_STREAM],
    run: runWeatherNws,
  },
  'deere.fields': {
    cron: '17 * * * *',
    demoEvery: '45 seconds',
    connector: 'CONNECTOR_DEERE',
    streams: Object.values(DEERE_FIELDS_STREAMS),
    run: runDeereFields,
  },
  'deere.ops': {
    cron: '*/15 * * * *',
    demoEvery: '20 seconds',
    connector: 'CONNECTOR_DEERE',
    streams: [DEERE_OPS_STREAM],
    run: runDeereOps,
  },
  'fleet.motive': {
    every: '30 seconds',
    demoEvery: '5 seconds',
    budgetMs: MOTIVE_BUDGET_MS,
    connector: 'CONNECTOR_MOTIVE',
    streams: [
      MOTIVE_POSITIONS_STREAM,
      MOTIVE_STATS_STREAM,
      MOTIVE_FAULTS_STREAM,
      MOTIVE_VEHICLES_STREAM,
    ],
    run: runFleetMotive,
  },
  'fleet.geotab': {
    every: '30 seconds',
    demoEvery: '10 seconds',
    budgetMs: 25_000,
    connector: 'CONNECTOR_GEOTAB',
    streams: [
      GEOTAB_POSITIONS_STREAM,
      GEOTAB_STATS_STREAM,
      GEOTAB_FAULTS_STREAM,
      GEOTAB_VEHICLES_STREAM,
    ],
    run: runFleetGeotab,
  },
  'fleet.equipment': {
    cron: '* * * * *',
    demoEvery: '10 seconds',
    connector: 'CONNECTOR_SAMSARA',
    streams: [EQUIPMENT_POSITIONS_STREAM, EQUIPMENT_STATS_STREAM],
    run: runFleetEquipment,
  },
  'fleet.aemp': {
    cron: '*/15 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_AEMP',
    streams: [AEMP_FLEET_STREAM, AEMP_FAULTS_STREAM],
    run: runFleetAemp,
  },
  'fleet.cnh': {
    cron: '*/5 * * * *',
    demoEvery: '30 seconds',
    connector: 'CONNECTOR_CNH',
    streams: [CNH_POSITIONS_STREAM, CNH_FLEET_STREAM, CNH_FAULTS_STREAM],
    run: runFleetCnh,
  },
  'fleet.terminal': {
    cron: '* * * * *',
    demoEvery: '15 seconds',
    connector: 'CONNECTOR_TERMINAL',
    streams: [
      TERMINAL_POSITIONS_STREAM,
      TERMINAL_STATS_STREAM,
      TERMINAL_FAULTS_STREAM,
      TERMINAL_VEHICLES_STREAM,
      TERMINAL_PROVIDERS_STREAM,
    ],
    run: runFleetTerminal,
  },
  'fleet.vehicles': {
    cron: '41 * * * *',
    demoEvery: '59 seconds',
    connector: 'CONNECTOR_SAMSARA',
    streams: [VEHICLES_STREAM],
    run: runFleetVehicles,
  },
  'usage.prune': {
    cron: '23 7 * * *',
    run: runUsagePrune,
  },
} satisfies JobRegistry;

/** The registry as a plain lookup table: `registry[name]` is `JobDef | undefined`. */
export const registry: JobRegistry = jobs;

/** Names of the registered jobs. */
export type JobName = keyof typeof jobs;
