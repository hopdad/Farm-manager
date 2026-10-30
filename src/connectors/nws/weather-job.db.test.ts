/**
 * weather.nws end to end in sim mode: the live NWS client against the stand-in (in-process,
 * stub world), the real database. Grid lookups cached per cell, forecast issues stored once,
 * observations, spray assessments for the current hour + 12, the wind slider flipping
 * verdicts with reasons, thresholds from app.settings (and back again), realtime, staleness
 * (counted from the last NWS check, not the issue time), and the replay mode on the
 * doc-derived fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { exec, toDate } from '../../db/exec';
import { readSprayThresholds, writeSprayThresholds } from '../../db/queries/weather';
import { verdictsForHour } from '../../db/queries/weather-spray';
import { loadStripData } from '../../db/queries/weather-strip';
import { withStaleness } from '../../domain/spray';
import {
  DEFAULT_SPRAY_THRESHOLDS,
  defaultSprayThresholdsSetting,
  SPRAY_ASSESS_AHEAD_HOURS,
  sprayAssessmentHours,
  sprayRulesVersion,
} from '../../domain/weather';
import { createWeatherNwsJob, type WeatherConfig } from '../../jobs/weather';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { createStubSimWorld } from '../../sim/vendors/stub-world';
import { setupTestDb } from '../../test/db';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import { buildWeatherStrip } from '../../ui/weather/strip-model';
import { listenAppEvents, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);

const H = 3_600_000;
/**
 * The test clock: the stand-in and the job both run on wall(). It starts 2 min into the current
 * UTC hour so no step below crosses an hour by accident: the spray window and the pruning follow
 * the UTC hour (a run just past one assesses a 13th hour and prunes), so with `Date.now()` here a
 * run started within a minute of the hour stored rows "a second run" must not. The stand-in's
 * forecast issues follow ITS hours (harvest-day starts 07:00 EDT sharp at speed 1, at
 * wall() = base): a new issue every hour after base, and when a knob changes.
 */
const base = Math.floor(Date.now() / H) * H + 2 * 60_000;
let offset = 0;
const wall = () => new Date(base + offset);

let sim: VendorSim;
let cfg: WeatherConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;
const fieldIds: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

const http = { timeoutMs: 5000, baseBackoffMs: 5, sleep: async () => {} };
const job = () => createWeatherNwsJob({ config: () => cfg, http });
const run = () => job()(testJobContext(t(), { name: 'weather.nws', now: wall }));

async function setWind(windMph: number | null, pattern?: string) {
  const res = await fetch(`${sim.url}/_control/vendor/nws/weather`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pattern === undefined ? { windMph } : { windMph, pattern }),
  });
  expect(res.status).toBe(200);
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const r = await exec<{ n: number }>(
    t().pool,
    `select count(*)::int as n from (${sql}) x`,
    values,
  );
  return r.rows[0]?.n ?? 0;
}

const currentHour = () => sprayAssessmentHours(wall(), 0)[0] as string;
const nwsRequests = () => sim.counters.requests.nws ?? 0;

/** farm.weather_grids.forecast_checked_at per cell (ISO; null: never checked). */
async function checkTimes(): Promise<Map<string, string | null>> {
  const r = await exec<{ id: string; at: unknown }>(
    t().pool,
    'select id, forecast_checked_at as at from farm.weather_grids order by id',
  );
  return new Map(r.rows.map((x) => [x.id, toDate(x.at)?.toISOString() ?? null]));
}

/** The cell of a field. */
async function cellOf(fieldId: string): Promise<string> {
  const r = await exec<{ grid_id: string }>(
    t().pool,
    'select grid_id from farm.field_weather_grids where field_id = $1',
    [fieldId],
  );
  return r.rows[0]?.grid_id ?? '';
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0, now: wall });
  sim.control.reset({ scenario: 'harvest-day' });
  cfg = {
    CONNECTOR_WEATHER: 'sim',
    VENDOR_SIM_URL: sim.url,
    NWS_USER_AGENT: 'farm-test (t@example.com)',
  };
  listener = await listenAppEvents(t().appUrl);
  // A and B share a cell west of Adrian; C is near Blissfield (another cell).
  fieldIds.a = (
    await insertField(t().db, { name: 'A 160', geom: squareMultiPolygon(-84.06, 41.89, 800) })
  ).fieldId;
  fieldIds.b = (
    await insertField(t().db, { name: 'B 40', geom: squareMultiPolygon(-84.05, 41.897, 300) })
  ).fieldId;
  fieldIds.c = (
    await insertField(t().db, { name: 'C 80', geom: squareMultiPolygon(-83.86, 41.83, 600) })
  ).fieldId;
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});
beforeEach(() => {
  listener.messages.length = 0;
});

describe('weather.nws in sim mode', () => {
  test('first run: cells looked up once each, forecasts, observations, 13 hours of verdicts', async () => {
    const before = nwsRequests();
    const result = await run();
    expect(result.note).toMatch(/2 cells; 2 new forecasts/);

    const grids = await exec<{ field_id: string; grid_id: string }>(
      t().pool,
      'select field_id::text, grid_id from farm.field_weather_grids order by grid_id',
    );
    expect(grids.rows).toHaveLength(3);
    const byField = new Map(grids.rows.map((r) => [r.field_id, r.grid_id]));
    expect(byField.get(fieldIds.a)).toBe(byField.get(fieldIds.b));
    expect(byField.get(fieldIds.c)).not.toBe(byField.get(fieldIds.a));

    const cells = await exec<{ id: string; stations: { id: string }[]; has_geom: boolean }>(
      t().pool,
      'select id, stations, geom is not null as has_geom from farm.weather_grids order by id',
    );
    expect(cells.rows).toHaveLength(2);
    expect(cells.rows.every((c) => c.has_geom && c.stations.length === 4)).toBe(true);
    const aCell = cells.rows.find((c) => c.id === byField.get(fieldIds.a));
    expect(aCell?.stations[0]?.id).toBe('KADG');
    // NWS answered for both cells: their forecasts are current as of this run.
    expect([...(await checkTimes()).values()]).toEqual([
      wall().toISOString(),
      wall().toISOString(),
    ]);

    // One issue per cell, ~5 days of hours each.
    const issues = await exec<{ grid_id: string; n: number }>(
      t().pool,
      'select grid_id, count(*)::int as n from farm.weather_forecasts group by grid_id, issued_at',
    );
    expect(issues.rows).toHaveLength(2);
    for (const r of issues.rows) expect(r.n).toBeGreaterThanOrEqual(5 * 24);

    expect(await count('select 1 from farm.weather_observations')).toBeGreaterThan(0);
    expect(
      await count(`select 1 from farm.spray_assessments where rules_version = $1`, [
        sprayRulesVersion(DEFAULT_SPRAY_THRESHOLDS),
      ]),
    ).toBe(3 * (SPRAY_ASSESS_AHEAD_HOURS + 1));
    // No cell outline is known before the first forecast, so each field asks /points once; A and
    // B (one new cell, looked up side by side) may both list its stations. Then 2 forecasts and
    // the observations of at most 2 nearest stations.
    expect(nwsRequests() - before).toBeLessThanOrEqual(3 + 3 + 2 + 2);

    await listener.settle();
    expect(listener.of('weather', 'updated')).toHaveLength(1);
    expect(listener.of('weather', 'updated')[0]?.payload.gridIds).toHaveLength(2);
    expect(listener.of('spray', 'assessed')).toHaveLength(1);
    expect(
      listener
        .of('fields', 'updated')
        .map((m) => m.payload.fieldId)
        .sort(),
    ).toEqual(Object.values(fieldIds).sort());
    const sync = await exec<{ stream: string; last_ok_at: Date | null; last_error: string | null }>(
      t().pool,
      `select stream, last_ok_at, last_error from ingest.sync_state where source = 'nws' order by stream`,
    );
    expect(sync.rows.map((r) => [r.stream, !!r.last_ok_at, r.last_error])).toEqual([
      ['forecast', true, null],
      ['observations', true, null],
    ]);
  });

  test('a second run in the same sim hour stores nothing new and publishes no verdicts', async () => {
    offset += 60_000;
    const rows = await count('select 1 from farm.spray_assessments');
    const forecasts = await count('select 1 from farm.weather_forecasts');
    const result = await run();
    expect(result.note).toMatch(/0 new forecasts/);
    expect(await count('select 1 from farm.spray_assessments')).toBe(rows);
    expect(await count('select 1 from farm.weather_forecasts')).toBe(forecasts);
    // The same issues again: still checked, as of this run.
    expect([...(await checkTimes()).values()]).toEqual([
      wall().toISOString(),
      wall().toISOString(),
    ]);
    await listener.settle();
    expect(listener.of('spray', 'assessed')).toHaveLength(0);
    expect(listener.of('fields', 'updated')).toHaveLength(0);
  });

  test('a new field inside a known cell reuses it without asking NWS', async () => {
    const d = await insertField(t().db, {
      name: 'D 20',
      geom: squareMultiPolygon(-84.055, 41.892, 200),
    });
    offset += 60_000;
    const before = nwsRequests();
    await run();
    const r = await exec<{ grid_id: string }>(
      t().pool,
      'select grid_id from farm.field_weather_grids where field_id = $1',
      [d.fieldId],
    );
    const a = await exec<{ grid_id: string }>(
      t().pool,
      'select grid_id from farm.field_weather_grids where field_id = $1',
      [fieldIds.a],
    );
    expect(r.rows[0]?.grid_id).toBe(a.rows[0]?.grid_id);
    // Forecasts (2 cells) + observations only: no /points, no /stations.
    expect(nwsRequests() - before).toBeLessThanOrEqual(2 + 4);
    await exec(t().pool, 'update farm.fields set active = false where id = $1', [d.fieldId]);
  });

  test('the wind slider: a new issue, every field no-go with its reasons, then back', async () => {
    offset += 60_000;
    await setWind(18);
    await run();
    const hour = currentHour();
    const windy = await verdictsForHour(t().pool, hour);
    for (const id of Object.values(fieldIds)) {
      const v = windy.get(id);
      expect(v?.verdict).toBe('no_go');
      expect(v?.reasons.map((r) => r.code)).toEqual(
        expect.arrayContaining(['wind_high', 'gust_high']),
      );
      expect(v?.reasons.find((r) => r.code === 'wind_high')?.message).toMatch(
        /^Wind 1[78] mph \(limit 10\)$/,
      );
    }
    await listener.settle();
    expect(listener.of('spray', 'assessed')).toHaveLength(1);
    expect(listener.of('spray', 'assessed')[0]?.payload.counts).toMatchObject({ noGo: 3 });
    expect(listener.of('fields', 'updated')).toHaveLength(3);

    listener.messages.length = 0;
    offset += 60_000;
    await setWind(5);
    await run();
    const light = await verdictsForHour(t().pool, hour);
    for (const id of Object.values(fieldIds)) {
      expect(light.get(id)?.reasons.map((r) => r.code)).not.toContain('wind_high');
      expect(light.get(id)?.verdict).not.toBe('no_go');
    }
    // The audit keeps both calls for the hour.
    expect(
      await count('select 1 from farm.spray_assessments where field_id = $1 and for_hour = $2', [
        fieldIds.a,
        hour,
      ]),
    ).toBeGreaterThanOrEqual(3);
  });

  test('thresholds come from app.settings; going back re-asserts the old row', async () => {
    offset += 60_000;
    await setWind(12);
    await run();
    const hour = currentHour();
    expect((await verdictsForHour(t().pool, hour)).get(fieldIds.a)?.verdict).toBe('no_go');

    const lenient = {
      ...DEFAULT_SPRAY_THRESHOLDS,
      windMaxMph: 20,
      windCautionMph: 15,
      gustMaxMph: 25,
    };
    await writeSprayThresholds(t().pool, {
      thresholds: lenient,
      isDefault: false,
      updatedAt: wall().toISOString(),
      updatedBy: 'Test manager',
    });
    expect((await readSprayThresholds(t().pool)).isDefault).toBe(false);
    offset += 1_000;
    await run();
    const ok = (await verdictsForHour(t().pool, hour)).get(fieldIds.a);
    expect(ok?.verdict).toBe('go');
    expect(ok?.rulesVersion).toBe(sprayRulesVersion(lenient));

    await writeSprayThresholds(t().pool, defaultSprayThresholdsSetting());
    offset += 1_000;
    const rows = await count('select 1 from farm.spray_assessments');
    await run();
    const back = (await verdictsForHour(t().pool, hour)).get(fieldIds.a);
    expect(back?.verdict).toBe('no_go');
    expect(back?.rulesVersion).toBe(sprayRulesVersion(DEFAULT_SPRAY_THRESHOLDS));
    // Same forecast issue, same rules: no new rows, the old ones re-asserted.
    expect(await count('select 1 from farm.spray_assessments')).toBe(rows);
    await setWind(null);
  });

  test('an NWS outage fails the job but still assesses: old issues show as stale', async () => {
    sim.control.faults({
      action: 'add',
      rule: { vendor: 'nws', kind: 'outage', label: 'nws down' },
    });
    try {
      const checked = await checkTimes();
      offset += 3 * 3_600_000; // the last good NWS check is now 3 h ago
      await expect(run()).rejects.toThrow(/nws/);
      expect(await checkTimes()).toEqual(checked);
      // The current hour was first assessed while the issue was fresh: its row stays, and the
      // views add the staleness.
      const v = (await verdictsForHour(t().pool, currentHour())).get(fieldIds.a);
      expect(v?.reasons.map((r) => r.code)).not.toContain('forecast_stale');
      const shown = v ? withStaleness(v, wall()) : null;
      expect(shown?.reasons.find((r) => r.code === 'forecast_stale')?.message).toBe(
        'Forecast not checked with NWS for 3 h',
      );
      expect(shown?.verdict).not.toBe('go');
      // An hour entering the window now is assessed with the stale issue: stored as such.
      const last = sprayAssessmentHours(wall()).at(-1) as string;
      const newest = (await verdictsForHour(t().pool, last)).get(fieldIds.a);
      expect(newest?.reasons.map((r) => r.code)).toContain('forecast_stale');
    } finally {
      sim.control.faults({ action: 'clear' });
    }
  });

  test('NWS serving the same issue for hours: current while every run checks it', async () => {
    // Live NWS keeps a grid's updateTime for hours (seen: issued 20:24Z, fetched 01:07Z). The
    // stand-in does the same while its clock is paused: it serves the issue of the paused hour.
    offset += 60_000;
    await run(); // NWS is back: this hour's issue lands
    sim.control.clock({ action: 'pause' });
    try {
      offset += 5 * H;
      const result = await run();
      expect(result.note).toMatch(/0 new forecasts/);
      const issues = await exec<{ issued_at: Date }>(
        t().pool,
        'select max(issued_at) as issued_at from farm.weather_forecasts group by grid_id',
      );
      expect(issues.rows).toHaveLength(2);
      for (const r of issues.rows) {
        expect(wall().getTime() - (toDate(r.issued_at) as Date).getTime()).toBeGreaterThan(5 * H);
      }
      expect([...(await checkTimes()).values()]).toEqual([
        wall().toISOString(),
        wall().toISOString(),
      ]);

      // Every hour of the window, as stored (the last 5 assessed now, with the 5 h old issue)
      // and as shown: no forecast_stale.
      for (const hour of sprayAssessmentHours(wall())) {
        const v = (await verdictsForHour(t().pool, hour)).get(fieldIds.a);
        expect(v?.forecastCheckedAt).toBe(wall().toISOString());
        expect(v?.reasons.map((r) => r.code)).not.toContain('forecast_stale');
        expect(v && withStaleness(v, wall()).reasons.map((r) => r.code)).not.toContain(
          'forecast_stale',
        );
      }
      const data = await loadStripData(t().pool, wall());
      const strip = buildWeatherStrip({
        now: wall(),
        mode: 'sim',
        grid: data.grid,
        issuedAt: data.issuedAt,
        fetchedAt: data.fetchedAt,
        checkedAt: data.checkedAt,
        hours: data.hours,
        observation: data.now,
        soilTemp: data.soilTemp,
        verdicts: data.verdicts,
        referenceVerdicts: data.referenceVerdicts,
      });
      expect(strip).toMatchObject({ stale: false, fetchedAt: wall().toISOString() });
    } finally {
      sim.control.clock({ action: 'resume' });
    }
  });

  test('failed forecasts leave forecast_checked_at alone; a partial run marks who answered', async () => {
    const before = await checkTimes();
    sim.control.faults({
      action: 'add',
      rule: { vendor: 'nws', pathPrefix: '/gridpoints', kind: 'outage', label: 'forecasts down' },
    });
    try {
      offset += 60_000;
      await expect(run()).rejects.toThrow(/nws/);
      expect(await checkTimes()).toEqual(before);
    } finally {
      sim.control.faults({ action: 'clear' });
    }

    // Only C's cell is down: A's (and B's) is checked, C's keeps its last good check.
    const aCell = await cellOf(fieldIds.a);
    const cCell = await cellOf(fieldIds.c);
    const [wfo, xy] = cCell.split('/');
    sim.control.faults({
      action: 'add',
      rule: { vendor: 'nws', pathPrefix: `/gridpoints/${wfo}/${xy}`, kind: 'outage' },
    });
    try {
      offset += 60_000;
      const result = await run();
      expect(result.note).toMatch(/1 of 2 forecasts failed/);
      const after = await checkTimes();
      expect(after.get(aCell)).toBe(wall().toISOString());
      expect(after.get(cCell)).toBe(before.get(cCell));
    } finally {
      sim.control.faults({ action: 'clear' });
    }
  });

  test('off does nothing', async () => {
    const off = createWeatherNwsJob({ config: () => ({ ...cfg, CONNECTOR_WEATHER: 'off' }), http });
    expect(await off(testJobContext(t(), { now: wall }))).toEqual({ items: 0, note: 'off' });
  });
});

describe('weather.nws in replay mode', () => {
  test('the doc-derived fixtures drive the same pipeline (one cell for the farm)', async () => {
    // The sim's cells are still cached: switching the mode drops them (they are not the replay
    // source's cells), so nothing has to be cleared by hand.
    expect(await count('select 1 from farm.weather_grids')).toBeGreaterThan(0);
    await exec(t().admin, `delete from ingest.sync_state where source = 'nws'`);
    const replay = createWeatherNwsJob({
      config: () => ({ ...cfg, CONNECTOR_WEATHER: 'replay' }),
      http,
    });
    const now = () => new Date();
    await replay(testJobContext(t(), { now }));
    const cells = await exec<{ grid_id: string }>(
      t().pool,
      'select distinct grid_id from farm.field_weather_grids',
    );
    expect(cells.rows.map((r) => r.grid_id)).toEqual(['DTX/31,40']);
    expect(await count('select 1 from farm.weather_grids')).toBe(1);
    const source = await exec<{ v: string }>(
      t().pool,
      `select value #>> '{}' as v from app.settings where key = 'weather.grid_source'`,
    );
    expect(source.rows[0]?.v).toBe('replay');
    expect(
      await count(`select 1 from farm.weather_forecasts where grid_id = 'DTX/31,40'`),
    ).toBeGreaterThan(100);
    expect(
      await count(
        `select 1 from farm.weather_forecasts where grid_id = 'DTX/31,40' and transport_wind_mph is not null`,
      ),
    ).toBe(0);
    const v = await verdictsForHour(t().pool, sprayAssessmentHours(now(), 0)[0] as string);
    expect(v.get(fieldIds.a)?.verdict).toMatch(/^(go|caution|no_go)$/);
  });
});
