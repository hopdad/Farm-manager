/**
 * The one schedule validator shared by the local clock (tools/clock) and `pnpm jobs:emit-cron`
 * (plan §1: "One validator serves the clock and jobs:emit-cron").
 *
 *  - `every`: only '1 seconds' … '59 seconds' (pg_cron's only interval form).
 *  - `cron`: exactly 5 fields (minute hour day-of-month month day-of-week), UTC, using only
 *    digits, '*', ',', '-' and '/' (the subset both croner and pg_cron accept identically).
 *    croner parses it to prove it is well-formed and to compute next runs.
 */
import { Cron } from 'croner';
import {
  DEFAULT_JOB_BUDGET_MS,
  type JobDef,
  type JobHost,
  type JobRegistry,
  MAX_JOB_BUDGET_MS,
} from './types';

export type Schedule = { kind: 'every'; seconds: number } | { kind: 'cron'; expr: string };

export interface ValidJob {
  name: string;
  schedule: Schedule;
  host: JobHost;
  budgetMs: number;
  def: JobDef;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

const JOB_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const EVERY = /^([1-9]|[1-5][0-9]) seconds$/;
const CRON_FIELD = /^[0-9*,/-]+$/;

/** '30 seconds' -> 30. Throws for anything outside 1-59 seconds. */
export function parseEvery(spec: string): number {
  const m = EVERY.exec(spec);
  if (!m) {
    throw new ScheduleError(
      `every '${spec}' is invalid: use '1 seconds' … '59 seconds'; a minute or more must be a cron string`,
    );
  }
  return Number(m[1]);
}

/** Throws unless `expr` is a 5-field UTC cron string valid for both croner and pg_cron. */
export function validateCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError(
      `cron '${expr}' must have exactly 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }
  for (const f of fields) {
    if (!CRON_FIELD.test(f)) {
      throw new ScheduleError(`cron '${expr}': field '${f}' may only use digits and * , - /`);
    }
  }
  try {
    new Cron(fields.join(' '), { timezone: 'UTC', paused: true }).stop();
  } catch (e) {
    throw new ScheduleError(`cron '${expr}': ${(e as Error).message}`);
  }
  return fields.join(' ');
}

export function validateJobName(name: string): void {
  if (!JOB_NAME.test(name) || name.length > 64) {
    throw new ScheduleError(`job name '${name}' must be dotted lower-case, e.g. 'fleet.trucks'`);
  }
}

/** Validate one registry entry. */
export function validateJobDef(name: string, def: JobDef): ValidJob {
  validateJobName(name);
  const d = def as { every?: string; cron?: string };
  if ((d.every === undefined) === (d.cron === undefined)) {
    throw new ScheduleError(`job '${name}' needs exactly one of 'every' or 'cron'`);
  }
  const schedule: Schedule =
    d.every !== undefined
      ? { kind: 'every', seconds: parseEvery(d.every) }
      : { kind: 'cron', expr: validateCron(d.cron as string) };
  const host = def.host ?? 'app';
  if (host !== 'app' && host !== 'pc')
    throw new ScheduleError(`job '${name}': unknown host '${host}'`);
  const budgetMs = def.budgetMs ?? DEFAULT_JOB_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > MAX_JOB_BUDGET_MS) {
    throw new ScheduleError(`job '${name}': budgetMs must be 1000-${MAX_JOB_BUDGET_MS}`);
  }
  if (typeof def.run !== 'function')
    throw new ScheduleError(`job '${name}': run is not a function`);
  return { name, schedule, host, budgetMs, def };
}

/** Validate a whole registry; throws one error listing every problem. */
export function validateRegistry(registry: JobRegistry): ValidJob[] {
  const out: ValidJob[] = [];
  const problems: string[] = [];
  for (const [name, def] of Object.entries(registry)) {
    try {
      out.push(validateJobDef(name, def));
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (problems.length)
    throw new ScheduleError(`invalid job registry:\n  - ${problems.join('\n  - ')}`);
  return out;
}

/** The pg_cron schedule text: '30 seconds' or the cron string. */
export function toPgCronSchedule(s: Schedule): string {
  return s.kind === 'every' ? `${s.seconds} seconds` : s.expr;
}

/**
 * Next fire time strictly after `from` (UTC). `every` jobs fire on multiples of their interval
 * since the epoch (so all clocks agree), e.g. every 30 s at :00 and :30.
 */
export function nextRun(s: Schedule, from: Date): Date {
  if (s.kind === 'every') {
    const step = s.seconds * 1000;
    return new Date((Math.floor(from.getTime() / step) + 1) * step);
  }
  const next = new Cron(s.expr, { timezone: 'UTC', paused: true }).nextRun(from);
  if (!next)
    throw new ScheduleError(`cron '${s.expr}' has no next run after ${from.toISOString()}`);
  return next;
}
