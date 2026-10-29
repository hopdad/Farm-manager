/**
 * The weather routes (plan 1b), framework-free so the DB tests call them under runWithSession.
 * Contract: src/ui/weather/contract.ts. Every read needs a session (requireRole('viewer'),
 * first); the soil temperature POST needs ROLE_FOR.enterSoilTemp, a same-origin request,
 * application/json and a small body. Every answer is JSON and `no-store` (limitedJson).
 */
import { type Config, getConfig } from '@/config';
import type { Db } from '@/db/client';
import type { Executor } from '@/db/exec';
import { readSprayThresholds } from '@/db/queries/weather';
import { fieldSprayHours, verdictsForHour } from '@/db/queries/weather-spray';
import {
  insertSoilTemp,
  isActiveField,
  latestSoilTemp,
  loadStripData,
  soilTempFieldOptions,
} from '@/db/queries/weather-strip';
import { isUuid } from '@/domain/ids';
import { withStaleness } from '@/domain/spray';
import { SPRAY_ASSESS_AHEAD_HOURS, sprayAssessmentHours } from '@/domain/weather';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR, type Role, roleAtLeast, type Session } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { publish } from '@/platform/realtime/publish';
import {
  type FieldSprayResponse,
  MAX_SOIL_TEMP_BODY_BYTES,
  SOIL_TEMP_FUTURE_SLACK_MINUTES,
  SOIL_TEMP_MAX_AGE_DAYS,
  type SoilTempFormData,
  type SoilTempResult,
  type SprayMapResponse,
  soilTempBodySchema,
  type WeatherStripPayload,
} from '@/ui/weather/contract';
import { buildWeatherStrip } from '@/ui/weather/strip-model';

type WeatherRouteConfig = Pick<Config, 'CONNECTOR_WEATHER' | 'NEXT_PUBLIC_REALTIME'>;

const NO_STORE = { 'cache-control': 'no-store' } as const;
const HOUR_MS = 3_600_000;

function json(status: number, body: unknown, route: string): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route });
}

/** requireRole, or the 401/403 response. */
async function authorize(min: Role): Promise<Session | Response> {
  try {
    return await requireRole(min);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
}

/**
 * Is the request from a page of this app (or not from a browser page at all)? Browsers send
 * `Origin` on every POST; it must name the host the request came to.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host.split(',')[0]?.trim();
  } catch {
    return false;
  }
}

function unavailable(route: string, e: unknown): Response {
  console.error(`[${route}]`, (e as Error).message);
  return json(503, { error: 'weather unavailable' }, route);
}

/** GET /api/weather/strip */
export async function handleStrip(
  ex: Executor,
  cfg: () => WeatherRouteConfig = getConfig,
  now: Date = new Date(),
): Promise<Response> {
  const route = 'api/weather/strip';
  const auth = await authorize(ROLE_FOR.viewPrivate);
  if (auth instanceof Response) return auth;
  try {
    const c = cfg();
    const [data, setting] = await Promise.all([loadStripData(ex, now), readSprayThresholds(ex)]);
    const strip = buildWeatherStrip({
      now,
      mode: c.CONNECTOR_WEATHER,
      grid: data.grid,
      issuedAt: data.issuedAt,
      fetchedAt: data.fetchedAt,
      hours: data.hours,
      observation: data.now,
      soilTemp: data.soilTemp,
      verdicts: data.verdicts,
      referenceVerdicts: data.referenceVerdicts,
    });
    const body: WeatherStripPayload = {
      ...strip,
      sprayThresholdsDefault: setting.isDefault,
      realtime: c.NEXT_PUBLIC_REALTIME,
    };
    return json(200, body, route);
  } catch (e) {
    return unavailable(route, e);
  }
}

/** GET /api/weather/spray: every field's verdict for the current hour. */
export async function handleSprayMap(
  ex: Executor,
  cfg: () => Pick<Config, 'NEXT_PUBLIC_REALTIME'> = getConfig,
  now: Date = new Date(),
): Promise<Response> {
  const route = 'api/weather/spray';
  const auth = await authorize(ROLE_FOR.viewPrivate);
  if (auth instanceof Response) return auth;
  try {
    const forHour = sprayAssessmentHours(now, 0)[0] as string;
    const [verdicts, setting] = await Promise.all([
      verdictsForHour(ex, forHour),
      readSprayThresholds(ex),
    ]);
    const body: SprayMapResponse = {
      builtAt: now.toISOString(),
      forHour,
      thresholdsDefault: setting.isDefault,
      realtime: cfg().NEXT_PUBLIC_REALTIME,
      fields: [...verdicts.values()]
        .map((v) => withStaleness(v, now))
        .map((v) => ({ fieldId: v.fieldId, verdict: v.verdict }))
        .sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
    };
    return json(200, body, route);
  } catch (e) {
    return unavailable(route, e);
  }
}

/** GET /api/weather/spray/<fieldId>: the current hour and the 12 after it, with reasons. */
export async function handleFieldSpray(
  ex: Executor,
  fieldId: string,
  cfg: () => Pick<Config, 'NEXT_PUBLIC_REALTIME'> = getConfig,
  now: Date = new Date(),
): Promise<Response> {
  const route = 'api/weather/spray/field';
  const auth = await authorize(ROLE_FOR.viewPrivate);
  if (auth instanceof Response) return auth;
  if (!isUuid(fieldId)) return json(404, { error: 'field not found' }, route);
  try {
    const from = sprayAssessmentHours(now, 0)[0] as string;
    const to = new Date(Date.parse(from) + (SPRAY_ASSESS_AHEAD_HOURS + 1) * HOUR_MS).toISOString();
    const [hours, setting, exists] = await Promise.all([
      fieldSprayHours(ex, fieldId, from, to),
      readSprayThresholds(ex),
      isActiveField(ex, fieldId),
    ]);
    if (!exists) return json(404, { error: 'field not found' }, route);
    const body: FieldSprayResponse = {
      builtAt: now.toISOString(),
      fieldId,
      thresholdsDefault: setting.isDefault,
      realtime: cfg().NEXT_PUBLIC_REALTIME,
      hours: hours.map((h) => withStaleness(h, now)),
    };
    return json(200, body, route);
  } catch (e) {
    return unavailable(route, e);
  }
}

/** GET /api/weather/soil-temp: the form's field list and the latest reading. */
export async function handleSoilTempForm(
  ex: Executor,
  cfg: () => Pick<Config, 'NEXT_PUBLIC_REALTIME'> = getConfig,
  now: Date = new Date(),
): Promise<Response> {
  const route = 'api/weather/soil-temp';
  const auth = await authorize(ROLE_FOR.viewPrivate);
  if (auth instanceof Response) return auth;
  try {
    const [fields, latest] = await Promise.all([soilTempFieldOptions(ex), latestSoilTemp(ex)]);
    const body: SoilTempFormData = {
      realtime: cfg().NEXT_PUBLIC_REALTIME,
      canEnter: roleAtLeast(auth.role, ROLE_FOR.enterSoilTemp),
      fields,
      latest: latest
        ? {
            ...latest,
            ageMinutes: Math.max(
              0,
              Math.floor((now.getTime() - Date.parse(latest.observedAt)) / 60_000),
            ),
          }
        : null,
    };
    return json(200, body, route);
  } catch (e) {
    return unavailable(route, e);
  }
}

/** POST /api/weather/soil-temp: a manual probe reading (strips refetch on weather/updated). */
export async function handlePostSoilTemp(
  request: Request,
  db: Db,
  now: Date = new Date(),
): Promise<Response> {
  const route = 'api/weather/soil-temp';
  const auth = await authorize(ROLE_FOR.enterSoilTemp);
  if (auth instanceof Response) return auth;
  if (!isSameOriginRequest(request))
    return json(403, { error: 'cross-site request refused' }, route);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    return json(415, { error: 'send the reading as application/json' }, route);
  }
  const text = await readLimitedText(request, MAX_SOIL_TEMP_BODY_BYTES);
  if (text === null) return json(413, { error: 'request body too large' }, route);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not valid JSON' }, route);
  }
  const parsed = soilTempBodySchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return json(
      400,
      { error: i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'bad reading' },
      route,
    );
  }
  const body = parsed.data;
  const observedMs = body.observedAt ? Date.parse(body.observedAt) : now.getTime();
  if (observedMs > now.getTime() + SOIL_TEMP_FUTURE_SLACK_MINUTES * 60_000) {
    return json(400, { error: 'observedAt is in the future' }, route);
  }
  if (observedMs < now.getTime() - SOIL_TEMP_MAX_AGE_DAYS * 24 * HOUR_MS) {
    return json(
      400,
      { error: `observedAt is more than ${SOIL_TEMP_MAX_AGE_DAYS} days ago` },
      route,
    );
  }
  try {
    const fieldId = body.fieldId ?? null;
    if (fieldId && !(await isActiveField(db, fieldId))) {
      return json(404, { error: 'field not found' }, route);
    }
    const observedAt = new Date(observedMs).toISOString();
    const id = await db.transaction(async (tx) => {
      const newId = await insertSoilTemp(tx, {
        fieldId,
        tempF: Math.round(body.tempF * 10) / 10,
        depthIn: body.depthIn ?? 2,
        observedAt,
        note: body.note ? body.note : null,
        enteredBy: auth.appUserId,
        deviceId: auth.deviceId,
      });
      await publish('weather', 'updated', { gridIds: [], issuedAt: null }, tx);
      return newId;
    });
    const result: SoilTempResult = { id, observedAt };
    return json(201, result, route);
  } catch (e) {
    return unavailable(route, e);
  }
}
