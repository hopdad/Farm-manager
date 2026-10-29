/**
 * src/jobs/registry.ts: one source for the local clock, the shop-PC worker and the Supabase
 * Cron SQL. All cron strings are UTC; `every` must be '1-59 seconds' (plan §1).
 *
 * Owner: the vendors agent adds entries (fleet.trucks, fleet.deere, …) to `jobs`.
 * Consumers (the clock, /api/jobs/[name], jobs:emit-cron) import `registry`, which is typed
 * `JobRegistry` so `registry[name]` compiles while `jobs` is still empty, and must run
 * `validateRegistry(registry)` first.
 */
import type { JobRegistry } from './types';

export const jobs = {} satisfies JobRegistry;

/** The registry as a plain lookup table: `registry[name]` is `JobDef | undefined`. */
export const registry: JobRegistry = jobs;

/** Names of the registered jobs (`never` until the first entry lands). */
export type JobName = keyof typeof jobs;
