/**
 * The weather routes against the real database, run as the sessions they serve: reads need a
 * session (viewer); soil temperature readings need ROLE_FOR.enterSoilTemp, a same-origin JSON
 * body within limits, a sane time and an active field, and publish weather/updated in the
 * insert's transaction. Stale forecasts show as caution in the spray views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { listenAppEvents } from '@/connectors/testkit';
import { assignFieldGrid, insertForecastIssue, upsertGrid } from '@/db/queries/weather';
import { writeAssessments } from '@/db/queries/weather-spray';
import { sprayAssessmentHours } from '@/domain/weather';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { insertField, squareMultiPolygon } from '@/test/fixtures';
import type {
  FieldSprayResponse,
  SoilTempFormData,
  SprayMapResponse,
  WeatherStripPayload,
} from '@/ui/weather/contract';
import {
  handleFieldSpray,
  handlePostSoilTemp,
  handleSoilTempForm,
  handleSprayMap,
  handleStrip,
} from './handler';

const t = setupTestDb(import.meta.url);
const cfg = () => ({ CONNECTOR_WEATHER: 'sim' as const, NEXT_PUBLIC_REALTIME: 'sse' as const });
const H = 3_600_000;

let fieldA: string;
let fieldB: string;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const as = (role: Role | null, extra: Partial<Session> = {}) =>
  role === null ? null : makeSession({ role, displayName: `Test ${role}`, ...extra });

async function read<T>(session: Session | null, fn: () => Promise<Response>) {
  const res = await runWithSession(session, fn);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
}

function soilRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3105/api/weather/soil-temp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const post = (
  session: Session | null,
  body: unknown,
  headers?: Record<string, string>,
  now?: Date,
) =>
  read<{ id: string; observedAt: string }>(session, () =>
    handlePostSoilTemp(soilRequest(body, headers), t().db, now),
  );

beforeAll(async () => {
  listener = await listenAppEvents(t().appUrl);
  fieldA = (
    await insertField(t().db, { name: 'North 80', geom: squareMultiPolygon(-84.06, 41.89, 600) })
  ).fieldId;
  fieldB = (
    await insertField(t().db, { name: 'South 40', geom: squareMultiPolygon(-84.06, 41.88, 400) })
  ).fieldId;
  const grid = { id: 'DTX/64,39', wfo: 'DTX', x: 64, y: 39 };
  await upsertGrid(
    t().pool,
    grid,
    [{ id: 'KADG', name: 'Adrian', lng: -84.08, lat: 41.87 }],
    null,
    new Date(),
  );
  for (const f of [fieldA, fieldB]) {
    await assignFieldGrid(t().pool, { fieldId: f, lng: -84.055, lat: 41.892 }, grid.id, new Date());
  }
  const start = Math.floor(Date.now() / H) * H;
  const issuedAt = new Date(start - 20 * 60_000).toISOString();
  await insertForecastIssue(
    t().pool,
    {
      grid,
      issuedAt,
      hours: Array.from({ length: 48 }, (_, k) => ({
        validAt: new Date(start + k * H).toISOString(),
        tempF: 50,
        dewpointF: 40,
        rhPct: 68,
        windMph: 6,
        gustMph: 10,
        windDir: 220,
        popPct: 10,
        qpfIn: 0,
        skyPct: 30,
        mixingHeightFt: 3000,
        transportWindMph: 12,
      })),
    },
    null,
  );
  const hours = sprayAssessmentHours(new Date());
  await writeAssessments(
    t().pool,
    hours.flatMap((h) => [
      {
        fieldId: fieldA,
        forHour: h,
        verdict: 'go' as const,
        reasons: [],
        inputs: {},
        rulesVersion: 'v0-t',
        forecastIssuedAt: issuedAt,
        gridId: grid.id,
      },
      {
        fieldId: fieldB,
        forHour: h,
        verdict: 'no_go' as const,
        reasons: [
          {
            code: 'wind_high' as const,
            verdict: 'no_go' as const,
            message: 'Wind 14 mph (limit 10)',
          },
        ],
        inputs: {},
        rulesVersion: 'v0-t',
        forecastIssuedAt: issuedAt,
        gridId: grid.id,
      },
    ]),
  );
});
afterAll(() => listener?.close());
beforeEach(() => {
  listener.messages.length = 0;
});

describe('reads', () => {
  test('a session is required (401 signed out); a viewer reads the strip', async () => {
    expect((await read(null, () => handleStrip(t().pool, cfg))).status).toBe(401);
    const { status, body } = await read<WeatherStripPayload>(as('viewer'), () =>
      handleStrip(t().pool, cfg),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      mode: 'sim',
      realtime: 'sse',
      stale: false,
      sprayThresholdsDefault: true,
      grid: { id: 'DTX/64,39' },
      spray: { go: 1, caution: 0, noGo: 1 },
    });
    expect(body.hours.length).toBeGreaterThan(0);
    // The reference field is the larger one (North 80): go.
    expect(body.hours[0]?.spray).toBe('go');
  });

  test('the spray map lists every field verdict for the current hour', async () => {
    expect((await read(null, () => handleSprayMap(t().pool, cfg))).status).toBe(401);
    const { status, body } = await read<SprayMapResponse>(as('viewer'), () =>
      handleSprayMap(t().pool, cfg),
    );
    expect(status).toBe(200);
    expect(body.forHour).toBe(sprayAssessmentHours(new Date(), 0)[0]);
    expect(Object.fromEntries(body.fields.map((f) => [f.fieldId, f.verdict]))).toEqual({
      [fieldA]: 'go',
      [fieldB]: 'no_go',
    });
    // Three hours later with no new forecast: the views say caution, stale.
    const later = new Date(Date.now() + 3 * H);
    const stale = await read<SprayMapResponse>(as('viewer'), () =>
      handleSprayMap(t().pool, cfg, new Date(Math.floor(later.getTime() / H) * H - 1)),
    );
    expect(stale.body.fields.find((f) => f.fieldId === fieldA)?.verdict).toBe('caution');
  });

  test("one field's hours with reasons; unknown or malformed ids are 404", async () => {
    const { status, body } = await read<FieldSprayResponse>(as('viewer'), () =>
      handleFieldSpray(t().pool, fieldB, cfg),
    );
    expect(status).toBe(200);
    expect(body.hours).toHaveLength(13);
    expect(body.hours[0]?.reasons.map((r) => r.message)).toEqual(['Wind 14 mph (limit 10)']);
    expect((await read(as('viewer'), () => handleFieldSpray(t().pool, 'nope', cfg))).status).toBe(
      404,
    );
    expect(
      (
        await read(as('viewer'), () =>
          handleFieldSpray(t().pool, '00000000-0000-4000-8000-000000000000', cfg),
        )
      ).status,
    ).toBe(404);
  });

  test('the soil form says who may enter', async () => {
    const viewer = await read<SoilTempFormData>(as('viewer'), () =>
      handleSoilTempForm(t().pool, cfg),
    );
    expect(viewer.body.canEnter).toBe(false);
    expect(viewer.body.fields.map((f) => f.name)).toEqual(['North 80', 'South 40']);
    const driver = await read<SoilTempFormData>(as('driver'), () =>
      handleSoilTempForm(t().pool, cfg),
    );
    expect(driver.body.canEnter).toBe(true);
  });
});

describe('soil temperature readings', () => {
  test('a viewer is refused (403) and signed out is 401: nothing written', async () => {
    expect((await post(as('viewer'), { tempF: 50 })).status).toBe(403);
    expect((await post(null, { tempF: 50 })).status).toBe(401);
    const r = await t().pool.query('select count(*)::int as n from farm.soil_temp_readings');
    expect(r.rows[0].n).toBe(0);
  });

  test('a driver saves one; it publishes weather/updated and shows on the strip with its age', async () => {
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await post(as('driver'), {
      fieldId: fieldA,
      tempF: 48.36,
      depthIn: 4,
      observedAt: at,
      note: ' north end ',
    });
    expect(r.status).toBe(201);
    expect(r.body.observedAt).toBe(at);
    const row = await t().pool.query(
      `select field_id::text, temp_f, depth_in, source, note, geom is not null as located
         from farm.soil_temp_readings where id = $1`,
      [r.body.id],
    );
    expect(row.rows[0]).toEqual({
      field_id: fieldA,
      temp_f: 48.4,
      depth_in: 4,
      source: 'manual',
      note: 'north end',
      located: true,
    });
    await listener.settle();
    expect(listener.of('weather', 'updated').map((m) => m.payload.gridIds)).toEqual([[]]);
    const strip = await read<WeatherStripPayload>(as('viewer'), () => handleStrip(t().pool, cfg));
    expect(strip.body.soilTemp).toMatchObject({ tempF: 48.4, depthIn: 4, fieldName: 'North 80' });
    expect(strip.body.soilTemp?.ageMinutes).toBeGreaterThanOrEqual(29);
  });

  test('defaults: no field, 2 inches, now', async () => {
    const r = await post(as('operator'), { tempF: 51 });
    expect(r.status).toBe(201);
    const row = await t().pool.query(
      'select field_id, depth_in from farm.soil_temp_readings where id = $1',
      [r.body.id],
    );
    expect(row.rows[0]).toEqual({ field_id: null, depth_in: 2 });
  });

  test('refusals: cross-site, not JSON, too big, bad body, bad time, unknown field', async () => {
    const d = as('driver');
    expect(
      (await post(d, { tempF: 50 }, { origin: 'http://evil.example', host: 'localhost:3105' }))
        .status,
    ).toBe(403);
    expect((await post(d, { tempF: 50 }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(d, { tempF: 50, note: 'x'.repeat(5000) })).status).toBe(413);
    expect((await post(d, '{nope')).status).toBe(400);
    expect((await post(d, { tempF: 500 })).status).toBe(400);
    expect((await post(d, { tempF: 50, extra: 1 })).status).toBe(400);
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect((await post(d, { tempF: 50, observedAt: future })).body.error).toMatch(/future/);
    const old = new Date(Date.now() - 8 * 24 * H).toISOString();
    expect((await post(d, { tempF: 50, observedAt: old })).status).toBe(400);
    expect(
      (await post(d, { tempF: 50, fieldId: '00000000-0000-4000-8000-000000000000' })).status,
    ).toBe(404);
  });
});
