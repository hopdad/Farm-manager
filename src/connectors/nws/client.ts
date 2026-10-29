/**
 * NWS live client (api.weather.gov; sim mode = this client against `${VENDOR_SIM_URL}/nws`,
 * replay = against the doc-derived fixtures). Implements the `ForecastSource` port
 * (src/connectors/types.ts) and exposes the raw calls the weather.nws job lands as raw events.
 *
 * Per the NWS API documentation (https://www.weather.gov/documentation/services-web-api):
 *  - every request carries a User-Agent identifying the app, with contact info
 *    (NWS_USER_AGENT; the API refuses requests without one);
 *  - `/points/{lat},{lon}` maps a location to its forecast office and 2.5 km grid cell
 *    (`gridId`, `gridX`, `gridY`); "applications may cache grid locations … but should
 *    periodically re-verify", which the job does (farm.weather_grids, GRID_LOOKUP_MAX_AGE_DAYS);
 *  - `forecastGridData` = `/gridpoints/{wfo}/{x},{y}` (raw layers with `updateTime`), and
 *    `/gridpoints/{wfo}/{x},{y}/stations` lists the cell's observation stations.
 * Paths are built from the grid id (the same templates the API returns as links), so a cached
 * cell needs no /points call.
 *
 * Coordinates are sent with at most 4 decimals (~11 m): NWS answers more precise points with a
 * redirect to the rounded one (doc-derived, confirm), and the cell is 2.5 km anyway.
 */
import type { z } from 'zod';
import type { Config } from '../../config';
import type { ForecastIssue, GridRef, Observation, WeatherStation } from '../../domain/weather';
import { type VendorHttpOptions, vendorJson } from '../http';
import type { ForecastSource, Mode } from '../types';
import { type NwsEndpoint, nwsEndpoint } from './endpoint';
import { gridOfPoint, type HourWindow, mapGridpoint, mapObservation, mapStations } from './mapper';
import {
  type NwsGridpoint,
  type NwsObservation,
  type NwsPoint,
  nwsGridpointSchema,
  nwsObservationCollectionSchema,
  nwsPointSchema,
  nwsStationCollectionSchema,
} from './schemas';

export type NwsHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

/** Most observations asked for per station and call (NWS allows 1-500). */
export const NWS_OBSERVATION_LIMIT = 100;

/** '41.89764' -> '41.8976'; '-84.0' -> '-84' (no trailing zeros). */
export function pointCoord(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError(`bad coordinate ${v}`);
  return String(Math.round(v * 1e4) / 1e4);
}

export class NwsClient implements ForecastSource {
  readonly endpoint: NwsEndpoint;
  private readonly http: NwsHttpOptions;

  constructor(endpoint: NwsEndpoint, http: NwsHttpOptions = {}) {
    this.endpoint = endpoint;
    // Replay never touches the network: its transport wins over any fetch passed in.
    this.http = endpoint.fetch ? { ...http, fetch: endpoint.fetch } : http;
  }

  static forMode(
    mode: Mode,
    cfg: Pick<Config, 'VENDOR_SIM_URL' | 'NWS_USER_AGENT'>,
    http: NwsHttpOptions = {},
  ): NwsClient {
    return new NwsClient(nwsEndpoint(mode, cfg, { now: http.now }), http);
  }

  private get<S extends z.ZodType>(
    schema: S,
    path: string,
    query: Record<string, string> = {},
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return vendorJson(
      schema,
      url.toString(),
      {
        method: 'GET',
        headers: {
          'user-agent': this.endpoint.userAgent,
          accept: 'application/geo+json',
        },
      },
      { ...this.http, vendor: 'nws' },
    );
  }

  /** GET /points/{lat},{lon}. */
  point(lng: number, lat: number): Promise<NwsPoint> {
    return this.get(nwsPointSchema, `/points/${pointCoord(lat)},${pointCoord(lng)}`);
  }

  /** GET /gridpoints/{wfo}/{x},{y}/stations, nearest to `near` first. */
  async stations(grid: GridRef, near?: { lng: number; lat: number }): Promise<WeatherStation[]> {
    const raw = await this.get(
      nwsStationCollectionSchema,
      `/gridpoints/${grid.wfo}/${grid.x},${grid.y}/stations`,
      { limit: '10' },
    );
    return mapStations(raw, near);
  }

  /** GET /gridpoints/{wfo}/{x},{y}: the raw forecast (validated). */
  gridpoint(grid: GridRef): Promise<NwsGridpoint> {
    return this.get(nwsGridpointSchema, `/gridpoints/${grid.wfo}/${grid.x},${grid.y}`);
  }

  /** GET /stations/{id}/observations?start=…: raw features, oldest first, after `since`. */
  async observationFeatures(stationId: string, since: Date): Promise<NwsObservation[]> {
    const raw = await this.get(
      nwsObservationCollectionSchema,
      `/stations/${encodeURIComponent(stationId)}/observations`,
      { start: since.toISOString(), limit: String(NWS_OBSERVATION_LIMIT) },
    );
    const after = since.getTime();
    return raw.features
      .filter((f) => Date.parse(f.properties.timestamp) > after)
      .sort((a, b) => Date.parse(a.properties.timestamp) - Date.parse(b.properties.timestamp));
  }

  // --- ForecastSource ---------------------------------------------------------------------------

  async gridFor(lng: number, lat: number): Promise<{ grid: GridRef; stations: WeatherStation[] }> {
    const p = await this.point(lng, lat);
    const grid = gridOfPoint(p);
    return { grid, stations: await this.stations(grid, { lng, lat }) };
  }

  async hourly(grid: GridRef, window: HourWindow = {}): Promise<ForecastIssue> {
    return mapGridpoint(await this.gridpoint(grid), window);
  }

  async observations(stationId: string, since: Date): Promise<Observation[]> {
    return (await this.observationFeatures(stationId, since)).map((f) =>
      mapObservation(f, stationId),
    );
  }
}
