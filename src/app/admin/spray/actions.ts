'use server';
/**
 * /admin/spray's server actions (plan 1b; D4). Every action checks the session first
 * (requireRole on the server: the browser's claims count for nothing), returns an
 * ActionResult (never throws to the client), and runs weather.nws right away so the verdicts
 * follow the change (src/app/api/weather/_lib/nudge.ts).
 *
 *  - saveThresholdsAction / resetThresholdsAction: app.settings 'spray.thresholds'
 *    (ROLE_FOR.editSprayThresholds, manager+). Saved values are no longer "defaults".
 *  - simWeatherAction: the NWS stand-in's wind slider and pattern (ROLE_FOR.admin; never in
 *    production, simulation only).
 */
import { revalidatePath } from 'next/cache';
import { nudgeText, nudgeWeatherJob } from '@/app/api/weather/_lib/nudge';
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { writeSprayThresholds } from '@/db/queries/weather';
import { defaultSprayThresholdsSetting } from '@/domain/weather';
import { requireRole } from '@/platform/auth/server';
import { isAuthError, ROLE_FOR } from '@/platform/auth/types';
import { type ActionResult, actionResult as result } from '../action-result';
import { parseSimWeatherForm, parseThresholdsForm } from './form';
import { setSimWeather } from './sim-weather';

const PATH = '/admin/spray';

async function attempt(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    const message = await fn();
    revalidatePath(PATH);
    return result(true, message);
  } catch (e) {
    if (isAuthError(e)) return result(false, e.message);
    return result(false, (e as Error).message);
  }
}

export async function saveThresholdsAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    const session = await requireRole(ROLE_FOR.editSprayThresholds);
    const parsed = parseThresholdsForm(form);
    if (!parsed.ok) throw new Error(parsed.message);
    await writeSprayThresholds(getPool(), {
      thresholds: parsed.thresholds,
      isDefault: false,
      updatedAt: new Date().toISOString(),
      updatedBy: session.displayName,
    });
    return `thresholds saved; ${nudgeText(await nudgeWeatherJob())}`;
  });
}

export async function resetThresholdsAction(
  _prev: ActionResult | null,
  _form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    await requireRole(ROLE_FOR.editSprayThresholds);
    await writeSprayThresholds(getPool(), defaultSprayThresholdsSetting());
    return `defaults restored; ${nudgeText(await nudgeWeatherJob())}`;
  });
}

export async function simWeatherAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(async () => {
    await requireRole(ROLE_FOR.admin);
    const cfg = getConfig();
    if (cfg.isProduction) throw new Error('simulation controls are off in production');
    const parsed = parseSimWeatherForm(form);
    if (!parsed.ok) throw new Error(parsed.message);
    const st = await setSimWeather(cfg.VENDOR_SIM_URL, parsed.request);
    const what =
      st.windMph === null
        ? `wind follows the ${st.effectivePattern} pattern`
        : `wind pinned at ${st.windMph} mph (${st.effectivePattern})`;
    const note =
      cfg.CONNECTOR_WEATHER === 'sim'
        ? ''
        : ` (CONNECTOR_WEATHER is ${cfg.CONNECTOR_WEATHER}: the app is not reading the stand-in)`;
    return `simulated weather: ${what}; ${nudgeText(await nudgeWeatherJob())}${note}`;
  });
}
