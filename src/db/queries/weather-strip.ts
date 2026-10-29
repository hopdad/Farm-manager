/**
 * Reads behind the weather strip (GET /api/weather/strip) and the soil temperature form
 * (plan 1b): the cell most fields share, its newest forecast issue, the nearest station's latest
 * observation, the latest soil temperature reading, and the spray verdicts. The strip itself is
 * assembled by the pure `buildWeatherStrip` (src/ui/weather/strip-model.ts).
 */
import type {
  GridRef,
  HourlyForecast,
  Observation,
  SprayVerdict,
  WeatherStation,
} from '../../domain/weather';
import { sprayAssessmentHours } from '../../domain/weather';
import { type Executor, exec, toDate } from '../exec';
import { forecastHours, gridsInUse } from './weather';
import { fieldSprayHours, verdictsForHour } from './weather-spray';

const HOUR_MS = 3_600_000;
/** An observation older than this is not "now". */
export const OBSERVATION_MAX_AGE_MINUTES = 180;
/** Strip hours shown (contract: up to 36). */
export const STRIP_HOURS = 36;

export interface SoilTempRow {
  tempF: number;
  depthIn: number;
  observedAt: string;
  source: 'manual' | 'station' | 'probe';
  fieldId: string | null;
  fieldName: string | null;
}

export interface StripData {
  grid: GridRef | null;
  issuedAt: string | null;
  fetchedAt: string | null;
  /** The issue's hours from 24 h ago to 5 days ahead (the builder keeps today + 3 days). */
  hours: HourlyForecast[];
  now: Observation | null;
  soilTemp: SoilTempRow | null;
  /** Current hour's verdict per field (newest row each). */
  verdicts: SprayVerdict[];
  /** The reference field's verdict per hour (the cell's largest field). */
  referenceVerdicts: Map<string, SprayVerdict>;
  referenceField: { id: string; name: string } | null;
}

function observationOf(x: Record<string, unknown>): Observation {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    stationId: String(x.station_id),
    stationName: (x.station_name as string | null) ?? null,
    observedAt: (toDate(x.observed_at) as Date).toISOString(),
    lng: n(x.lng),
    lat: n(x.lat),
    tempF: n(x.temp_f),
    dewpointF: n(x.dewpoint_f),
    rhPct: n(x.rh_pct),
    windMph: n(x.wind_mph),
    gustMph: n(x.gust_mph),
    windDir: n(x.wind_dir),
    precipLastHourIn: n(x.precip_last_hour_in),
  };
}

/** The newest observation of the first station (nearest first) that reported recently. */
export async function latestObservation(
  ex: Executor,
  stations: WeatherStation[],
  now: Date,
): Promise<Observation | null> {
  if (!stations.length) return null;
  const ids = stations.map((s) => s.id);
  const r = await exec<Record<string, unknown>>(
    ex,
    `select distinct on (o.station_id) o.station_id, o.observed_at,
            extensions.ST_X(o.geom) as lng, extensions.ST_Y(o.geom) as lat,
            o.temp_f, o.dewpoint_f, o.rh_pct, o.wind_mph, o.gust_mph, o.wind_dir,
            o.precip_last_hour_in
       from farm.weather_observations o
      where o.station_id = any($1::text[])
        and o.observed_at >= $2::timestamptz and o.observed_at <= $3::timestamptz
      order by o.station_id, o.observed_at desc`,
    [
      ids,
      new Date(now.getTime() - OBSERVATION_MAX_AGE_MINUTES * 60_000).toISOString(),
      new Date(now.getTime() + 5 * 60_000).toISOString(),
    ],
  );
  const byId = new Map(r.rows.map((x) => [String(x.station_id), x] as const));
  for (const s of stations) {
    const row = byId.get(s.id);
    if (row) return observationOf({ ...row, station_name: s.name });
  }
  return null;
}

export async function latestSoilTemp(ex: Executor): Promise<SoilTempRow | null> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select s.temp_f, s.depth_in, s.observed_at, s.source, s.field_id::text as field_id,
            f.name as field_name
       from farm.soil_temp_readings s
       left join farm.fields f on f.id = s.field_id
      order by s.observed_at desc, s.created_at desc
      limit 1`,
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    tempF: Number(x.temp_f),
    depthIn: Number(x.depth_in),
    observedAt: (toDate(x.observed_at) as Date).toISOString(),
    source: x.source as SoilTempRow['source'],
    fieldId: (x.field_id as string | null) ?? null,
    fieldName: (x.field_name as string | null) ?? null,
  };
}

export async function loadStripData(ex: Executor, now: Date): Promise<StripData> {
  const grids = await gridsInUse(ex);
  const main = grids[0] ?? null;
  const forHour = sprayAssessmentHours(now, 0)[0] as string;
  const [verdicts, soilTemp] = await Promise.all([
    verdictsForHour(ex, forHour),
    latestSoilTemp(ex),
  ]);
  const out: StripData = {
    grid: main ? { id: main.id, wfo: main.wfo, x: main.x, y: main.y } : null,
    issuedAt: null,
    fetchedAt: null,
    hours: [],
    now: null,
    soilTemp,
    verdicts: [...verdicts.values()].map((v) => v.verdict),
    referenceVerdicts: new Map(),
    referenceField: null,
  };
  if (!main) return out;

  const issue = await exec<{ issued_at: unknown; fetched_at: unknown }>(
    ex,
    `select issued_at, max(fetched_at) as fetched_at from farm.weather_forecasts
      where grid_id = $1 group by issued_at order by issued_at desc limit 1`,
    [main.id],
  );
  const row = issue.rows[0];
  if (row) {
    out.issuedAt = (toDate(row.issued_at) as Date).toISOString();
    out.fetchedAt = toDate(row.fetched_at)?.toISOString() ?? null;
    out.hours = await forecastHours(
      ex,
      main.id,
      out.issuedAt,
      new Date(now.getTime() - 24 * HOUR_MS),
      new Date(now.getTime() + 5 * 24 * HOUR_MS),
    );
  }
  out.now = await latestObservation(ex, main.stations, now);

  const ref = await exec<{ id: string; name: string }>(
    ex,
    `select f.id::text as id, f.name
       from farm.field_weather_grids w
       join farm.fields f on f.id = w.field_id and f.active
       join farm.current_boundaries b on b.field_id = f.id
      where w.grid_id = $1
      order by b.acres desc, f.name, f.id
      limit 1`,
    [main.id],
  );
  const refRow = ref.rows[0];
  if (refRow) {
    out.referenceField = refRow;
    const views = await fieldSprayHours(
      ex,
      refRow.id,
      forHour,
      new Date(Date.parse(forHour) + STRIP_HOURS * HOUR_MS).toISOString(),
    );
    out.referenceVerdicts = new Map(views.map((v) => [v.forHour, v.verdict] as const));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Soil temperature readings (manual probe readings from a phone, 1b)
// ---------------------------------------------------------------------------------------------

export interface NewSoilTemp {
  fieldId: string | null;
  tempF: number;
  depthIn: number;
  observedAt: string;
  note: string | null;
  enteredBy: string | null;
  deviceId: string | null;
}

/** Insert a manual reading (located at a point in the field's current boundary). Returns its id. */
export async function insertSoilTemp(ex: Executor, r: NewSoilTemp): Promise<string> {
  const res = await exec<{ id: string }>(
    ex,
    `insert into farm.soil_temp_readings
       (field_id, observed_at, depth_in, temp_f, source, geom, entered_by, device_id, note)
     values ($1::uuid, $2::timestamptz, $3, $4, 'manual',
             (select extensions.ST_PointOnSurface(b.geom) from farm.current_boundaries b
               where b.field_id = $1::uuid limit 1),
             $5::uuid, $6::uuid, $7)
     returning id::text as id`,
    [r.fieldId, r.observedAt, r.depthIn, r.tempF, r.enteredBy, r.deviceId, r.note],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('soil temperature insert returned no id');
  return id;
}

/** Active fields for the form's picker, by name. */
export async function soilTempFieldOptions(ex: Executor): Promise<{ id: string; name: string }[]> {
  const r = await exec<{ id: string; name: string }>(
    ex,
    `select id::text as id, name from farm.fields where active order by name, id`,
  );
  return r.rows;
}

/** Is `id` an active field? */
export async function isActiveField(ex: Executor, id: string): Promise<boolean> {
  const r = await exec(ex, 'select 1 from farm.fields where id = $1::uuid and active', [id]);
  return r.rowCount > 0;
}
