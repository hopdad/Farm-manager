/**
 * src/jobs/registry.ts: one source for the local clock, the shop-PC worker and the Supabase
 * Cron SQL. All cron strings are UTC; `every` must be '1-59 seconds' (plan §1).
 *
 * Owner: the connectors/fleet agent adds entries (fleet.trucks, fleet.deere, …). The clock and
 * /api/jobs/[name] import `jobs` from here and must run `validateRegistry(jobs)` first.
 */
import type { JobRegistry } from './types';

export const jobs = {} satisfies JobRegistry;

export type JobName = keyof typeof jobs;
