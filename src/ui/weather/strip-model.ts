/**
 * The weather strip's view model (contract: `WeatherStrip`, src/domain/weather.ts), built on
 * the server from the reads in src/db/queries/weather-strip.ts. Pure (Intl only), so it is
 * unit-tested without a database.
 *
 *  - days: today plus the next 3 calendar days in America/Detroit, from the newest issue's hours
 *    (high/low temperature, rain total, highest PoP, wind and gusts);
 *  - hours: from the current hour, up to 36, each with the reference field's spray verdict
 *    where one is stored (null past the stored window);
 *  - stale: no forecast, or its issue older than WEATHER_STALE_MINUTES.
 */
import { countVerdicts } from '../../domain/spray';
import {
  type GridRef,
  type HourlyForecast,
  type Observation,
  type SprayVerdict,
  WEATHER_STALE_MINUTES,
  type WeatherStrip,
  type WeatherStripDay,
  type WeatherStripHour,
} from '../../domain/weather';

export const FARM_TIME_ZONE = 'America/Detroit';
const HOUR_MS = 3_600_000;
const STRIP_DAYS = 4;
const STRIP_HOURS = 36;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: FARM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: FARM_TIME_ZONE, weekday: 'short' });

/** YYYY-MM-DD of an instant in the farm's time zone. */
export function localDate(ms: number): string {
  return dateFmt.format(new Date(ms));
}

export interface StripInputs {
  now: Date;
  mode: WeatherStrip['mode'];
  grid: GridRef | null;
  issuedAt: string | null;
  fetchedAt: string | null;
  hours: readonly HourlyForecast[];
  observation: Observation | null;
  soilTemp: {
    tempF: number;
    depthIn: number;
    observedAt: string;
    source: 'manual' | 'station' | 'probe';
    fieldId: string | null;
    fieldName: string | null;
  } | null;
  /** Current-hour verdict of every field that has one. */
  verdicts: readonly SprayVerdict[];
  /** The reference field's verdict per hour (UTC ISO hour -> verdict). */
  referenceVerdicts: ReadonlyMap<string, SprayVerdict>;
}

const max = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};
const min = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};
const round = (v: number | null, digits = 0) =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

export function buildWeatherStrip(i: StripInputs): WeatherStrip {
  const nowMs = i.now.getTime();
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const sorted = [...i.hours].sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));

  // Days: today + 3 in the farm's time zone.
  const today = localDate(nowMs);
  const byDay = new Map<string, HourlyForecast[]>();
  for (const h of sorted) {
    const d = localDate(Date.parse(h.validAt));
    if (d < today) continue;
    const list = byDay.get(d) ?? [];
    list.push(h);
    byDay.set(d, list);
  }
  const days: WeatherStripDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, STRIP_DAYS)
    .map(([date, hs]) => {
      const qpf = hs.map((h) => h.qpfIn).filter((x): x is number => x !== null);
      return {
        date,
        label:
          date === today ? 'Today' : weekdayFmt.format(new Date(Date.parse(hs[0]?.validAt ?? ''))),
        highF: round(max(hs.map((h) => h.tempF))),
        lowF: round(min(hs.map((h) => h.tempF))),
        rainIn: qpf.length
          ? round(
              qpf.reduce((s, x) => s + x, 0),
              2,
            )
          : null,
        maxPopPct: round(max(hs.map((h) => h.popPct))),
        maxWindMph: round(max(hs.map((h) => h.windMph))),
        maxGustMph: round(max(hs.map((h) => h.gustMph))),
      };
    });

  const hours: WeatherStripHour[] = sorted
    .filter((h) => Date.parse(h.validAt) >= currentHour)
    .slice(0, STRIP_HOURS)
    .map((h) => ({ ...h, spray: i.referenceVerdicts.get(h.validAt) ?? null }));

  const issueAge = i.issuedAt === null ? null : (nowMs - Date.parse(i.issuedAt)) / 60_000;
  const soil = i.soilTemp
    ? {
        ...i.soilTemp,
        ageMinutes: Math.max(0, Math.floor((nowMs - Date.parse(i.soilTemp.observedAt)) / 60_000)),
      }
    : null;
  return {
    builtAt: i.now.toISOString(),
    grid: i.grid,
    issuedAt: i.issuedAt,
    fetchedAt: i.fetchedAt,
    stale: issueAge === null || issueAge > WEATHER_STALE_MINUTES,
    mode: i.mode,
    now: i.observation,
    days,
    hours,
    soilTemp: soil,
    spray: i.verdicts.length
      ? { forHour: new Date(currentHour).toISOString(), ...countVerdicts(i.verdicts) }
      : null,
  };
}

/** What GET /api/weather/strip answers: the strip plus whether the thresholds are defaults. */
export interface WeatherStripResponse extends WeatherStrip {
  /** True while the D4 thresholds are the shipped defaults (the strip says so). */
  sprayThresholdsDefault: boolean;
}
