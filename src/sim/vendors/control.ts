/**
 * Wire schemas of the stand-in's control API (contracts §9; types in src/sim/types.ts).
 * `faultsControlRequestSchema` lives in ./faults.ts next to the rule logic.
 */
import { z } from 'zod';
import {
  type ClockControlRequest,
  type ResetControlRequest,
  SCENARIO_NAMES,
  type ScenarioControlRequest,
} from '../types';
import { MAX_SIM_SPEED } from './clock';

const iso = z.iso.datetime({ offset: true });
const speed = z.number().positive().max(MAX_SIM_SPEED);
const seed = z.number().int().min(0).max(2_147_483_647);

export const clockControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('resume') }),
  z.strictObject({ action: z.literal('speed'), speed }),
  z.strictObject({ action: z.literal('jump'), simTime: iso }),
  z.strictObject({ action: z.literal('freeze'), simTime: iso }),
]) satisfies z.ZodType<ClockControlRequest>;

export const scenarioControlRequestSchema = z.strictObject({
  scenario: z.enum(SCENARIO_NAMES),
  seed: seed.optional(),
}) satisfies z.ZodType<ScenarioControlRequest>;

export const resetControlRequestSchema = z.strictObject({
  scenario: z.enum(SCENARIO_NAMES).optional(),
  seed: seed.optional(),
  clearFaults: z.boolean().optional(),
  speed: speed.optional(),
}) satisfies z.ZodType<ResetControlRequest>;

/** First issue of a failed parse, as `path: message`. */
export function firstIssue(error: z.ZodError): string {
  const i = error.issues[0];
  if (!i) return 'invalid request';
  return `${i.path.join('.') || '(body)'}: ${i.message}`;
}
