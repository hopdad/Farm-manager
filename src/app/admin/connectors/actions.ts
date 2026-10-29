'use server';
/**
 * Server actions behind /admin/connectors. They run on the PC, so they can reach the stand-in's
 * loopback-only control API, and they write app.settings as farm_app.
 * Every action returns an ActionResult for useActionState (no throws to the client).
 * M0 has no sign-in (slice 1a adds manager sessions); sim controls refuse in production.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getConfig } from '@/config';
import { getDb } from '@/db/client';
import { SCENARIO_NAMES } from '@/sim/types';
import { setClockPaused } from '../../api/jobs/_lib/clock-setting';
import { type ActionResult, actionResult as result } from '../action-result';
import { faultPresets, simClock, simFaults, simReset, simScenario } from './sim-control';

const PATH = '/admin/connectors';

async function attempt(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    const message = await fn();
    revalidatePath(PATH);
    return result(true, message);
  } catch (e) {
    return result(false, e instanceof z.ZodError ? 'invalid request' : (e as Error).message);
  }
}

function simBase(): string {
  const cfg = getConfig();
  if (cfg.isProduction) throw new Error('simulation controls are off in production');
  return cfg.VENDOR_SIM_URL;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

/** Job clock pause/resume: app.settings 'clock.paused' + publish admin/clock { paused }. */
export async function setClockPausedAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const paused = z.enum(['true', 'false']).parse(field(form, 'paused')) === 'true';
    await setClockPaused(getDb(), paused);
    return paused ? 'job clock paused: no syncs run, data goes stale' : 'job clock running';
  });
}

const clockForm = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('speed'), speed: z.coerce.number().positive().max(3600) }),
]);

/** Simulation clock: pause / resume / speed (the stand-in keeps machines fresh while paused). */
export async function simClockAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const req = clockForm.parse({ action: field(form, 'action'), speed: field(form, 'speed') });
    const st = await simClock(simBase(), req);
    if (req.action === 'speed') return `simulation speed ${st.speed}x`;
    return st.paused ? 'simulation paused: machines freeze (still fresh)' : 'simulation running';
  });
}

/** Switch scenario (re-anchors the sim clock at the scenario start). */
export async function simScenarioAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const scenario = z.enum(SCENARIO_NAMES).parse(field(form, 'scenario'));
    const st = await simScenario(simBase(), { scenario });
    return `scenario ${st.scenario} (seed ${st.seed}) from ${st.startsAt}`;
  });
}

const faultForm = z.discriminatedUnion('op', [
  z.object({ op: z.literal('on'), preset: z.string().min(1) }),
  z.object({ op: z.literal('off'), preset: z.string().min(1) }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(200) }),
  z.object({ op: z.literal('clear') }),
]);

/** Fault toggles: a preset on/off, remove one rule, or clear all control-API rules. */
export async function simFaultAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const req = faultForm.parse({
      op: field(form, 'op'),
      preset: field(form, 'preset'),
      id: field(form, 'id'),
    });
    const base = simBase();
    if (req.op === 'clear') {
      await simFaults(base, { action: 'clear' });
      return 'all faults cleared';
    }
    if (req.op === 'remove') {
      await simFaults(base, { action: 'remove', id: req.id });
      return `fault ${req.id} removed`;
    }
    const preset = faultPresets(getConfig().ELD_VENDOR).find((p) => p.key === req.preset);
    if (!preset) throw new Error(`unknown fault '${req.preset}'`);
    if (req.op === 'on') {
      await simFaults(base, { action: 'add', rule: { id: preset.id, ...preset.rule } });
      return `${preset.title}: on`;
    }
    await simFaults(base, { action: 'remove', id: preset.id });
    return `${preset.title}: off`;
  });
}

/** Back to a clean vendor state (tokens, cursors, webhooks, faults), same scenario. */
export async function simResetAction(
  _prev: ActionResult | null,
  _form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const st = await simReset(simBase(), { clearFaults: true });
    return `stand-in reset: ${st.scenario.scenario}, ${st.clock.speed}x`;
  });
}
