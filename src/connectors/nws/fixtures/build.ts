/**
 * Builds the DOC-DERIVED NWS replay fixtures (docs/contracts-m1.md §10: "Weather ships NWS
 * fixtures the same way for CONNECTOR_WEATHER=replay").
 *
 * SHAPES: the NWS API's OpenAPI document (https://api.weather.gov/openapi.json, v2.0.0:
 * PointGeoJson, GridpointGeoJson with GridpointQuantitativeValueLayer, ISO8601Interval,
 * ObservationStationCollectionGeoJson, ObservationCollectionGeoJson, QuantitativeValue) and
 * https://www.weather.gov/documentation/services-web-api. Unit codes (wmoUnit:degC, km_h-1, mm,
 * m, percent, degree_(angle)) and the run-length `validTime` intervals are written the way the
 * API answers (doc-derived, confirm: src/connectors/nws/doc-derived.ts). Like real grids, the
 * fixture has a windGust layer with a gap (null) and NO transportWindSpeed layer, so the
 * "layer absent" path runs in replay.
 *
 * VALUES: an invented late-October week around Adrian, MI (calm sunrise with an inversion
 * risk, a windy afternoon, rain the second night). No real farm data; the grid cell id and the
 * station list are illustrative. Every /points request is answered with the one point here
 * (./replay.ts maps any coordinates to it), so the whole farm shares this cell in replay.
 *
 * TIME: anchored at ANCHOR with a 1-hour shift step, so instants stay on whole hours and each
 * hour of wall time yields one new forecast issue (like NWS's roughly hourly updates).
 * The committed JSON under ./doc-derived/ is this module's output (./fixtures.test.ts fails on
 * drift); regenerate with `pnpm exec tsx src/connectors/nws/fixtures/write.ts`, then
 * `pnpm lint:fix`.
 */
import type { ReplayFixture } from '../../replay';

export const ANCHOR = '2026-10-29T12:00:00.000Z';
export const REPLAY_POINT = { lat: 41.9, lng: -84.03 };
export const REPLAY_GRID = { wfo: 'DTX', x: 31, y: 40 };
const NWS = 'https://api.weather.gov';
const HOUR = 3_600_000;
const STEP = 3600;

const REF =
  'https://api.weather.gov/openapi.json (v2.0.0) and https://www.weather.gov/documentation/services-web-api';
const VALUES = 'Values: an invented week near Adrian, MI; no real farm data.';

/** NWS instant format: +00:00 offset, whole seconds. */
const at = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+00:00');
const ctx = ['https://geojson.org/geojson-ld/geojson-context.jsonld'];

/** Forecast hours start here (the issue's first hour). */
const START = Date.parse('2026-10-29T06:00:00.000Z');
const DAYS = 7;

/** One run: hours from the previous run's end, value in the layer's unit. */
type Run = [hours: number, value: number | null];

/** Runs -> NWS values, each `<start>/PT<n>H`; the runs must cover DAYS days exactly. */
function layer(uom: string, runs: Run[]) {
  let t = START;
  const values = runs.map(([n, value]) => {
    const v = { validTime: `${at(t)}/PT${n}H`, value };
    t += n * HOUR;
    return v;
  });
  const total = (t - START) / HOUR;
  if (total !== DAYS * 24) throw new Error(`${uom} layer covers ${total} h, not ${DAYS * 24}`);
  return { uom, values };
}

/** A repeated daily shape (24 h of runs) for `days` days, then `tail` runs. */
function days(day: Run[], n: number): Run[] {
  return Array.from({ length: n }, () => day).flat();
}

/** °F -> °C as NWS publishes it (converted from the forecaster's °F: long decimals). */
const c = (f: number) => ((f - 32) * 5) / 9;
/** knots -> km/h (NWS forecasts wind in knots and publishes km/h). */
const kmh = (kt: number) => Math.round(kt * 1.852 * 1000) / 1000;

function gridpointBody() {
  const id = `${NWS}/gridpoints/${REPLAY_GRID.wfo}/${REPLAY_GRID.x},${REPLAY_GRID.y}`;
  // Day shapes start at 06 UTC (02:00 EDT).
  const tempDay: Run[] = [
    [3, c(41)],
    [2, c(40)],
    [2, c(43)],
    [2, c(49)],
    [3, c(55)],
    [3, c(58)],
    [3, c(54)],
    [3, c(48)],
    [3, c(44)],
  ];
  const dewDay: Run[] = [
    [5, c(39)],
    [4, c(40)],
    [6, c(42)],
    [9, c(40)],
  ];
  const rhDay: Run[] = [
    [5, 93],
    [4, 82],
    [6, 58],
    [9, 80],
  ];
  // Calm clear dawn (inversion risk), windy afternoon on day 1, breezy afterwards.
  const windDay1: Run[] = [
    [5, kmh(1)],
    [3, kmh(3)],
    [4, kmh(7)],
    [5, kmh(13)],
    [7, kmh(5)],
  ];
  const windDay: Run[] = [
    [5, kmh(3)],
    [3, kmh(5)],
    [9, kmh(6)],
    [7, kmh(4)],
  ];
  const gustDay1: Run[] = [
    [8, null],
    [4, kmh(12)],
    [5, kmh(21)],
    [7, kmh(9)],
  ];
  const gustDay: Run[] = [
    [8, kmh(7)],
    [9, kmh(10)],
    [7, kmh(7)],
  ];
  const skyDay1: Run[] = [
    [8, 5],
    [9, 30],
    [7, 60],
  ];
  const skyDay2: Run[] = [
    [8, 95],
    [9, 70],
    [7, 40],
  ];
  const skyDay: Run[] = [
    [8, 20],
    [9, 35],
    [7, 25],
  ];
  const popDay1: Run[] = [
    [12, 2],
    [6, 10],
    [6, 40],
  ];
  const popDay2: Run[] = [
    [6, 80],
    [6, 50],
    [12, 10],
  ];
  const popDay: Run[] = [
    [12, 5],
    [12, 3],
  ];
  // QPF: 6-hour totals (mm), aligned to 00/06/12/18 UTC like NWS's.
  const qpfDay1: Run[] = [
    [6, 0],
    [6, 0],
    [6, 0],
    [6, 1.27],
  ];
  const qpfDay2: Run[] = [
    [6, 6.35],
    [6, 2.03],
    [6, 0],
    [6, 0],
  ];
  const qpfDay: Run[] = [
    [6, 0],
    [6, 0],
    [6, 0],
    [6, 0],
  ];
  const mixDay: Run[] = [
    [6, 152],
    [3, 610],
    [8, 1402],
    [7, 305],
  ];
  const dirDay1: Run[] = [
    [8, 180],
    [9, 270],
    [7, 290],
  ];
  const dirDay: Run[] = [
    [8, 160],
    [9, 220],
    [7, 200],
  ];
  return {
    '@context': ctx,
    id,
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-84.0412, 41.8902],
          [-84.0127, 41.8935],
          [-84.0083, 41.9147],
          [-84.0368, 41.9114],
          [-84.0412, 41.8902],
        ],
      ],
    },
    properties: {
      '@id': id,
      '@type': 'wx:Gridpoint',
      updateTime: '2026-10-29T11:42:31+00:00',
      validTimes: `${at(START)}/P${DAYS}D`,
      elevation: { unitCode: 'wmoUnit:m', value: 243.84 },
      forecastOffice: `${NWS}/offices/${REPLAY_GRID.wfo}`,
      gridId: REPLAY_GRID.wfo,
      gridX: REPLAY_GRID.x,
      gridY: REPLAY_GRID.y,
      temperature: layer('wmoUnit:degC', days(tempDay, DAYS)),
      dewpoint: layer('wmoUnit:degC', days(dewDay, DAYS)),
      relativeHumidity: layer('wmoUnit:percent', days(rhDay, DAYS)),
      skyCover: layer('wmoUnit:percent', [...skyDay1, ...skyDay2, ...days(skyDay, DAYS - 2)]),
      windDirection: layer('wmoUnit:degree_(angle)', [...dirDay1, ...days(dirDay, DAYS - 1)]),
      windSpeed: layer('wmoUnit:km_h-1', [...windDay1, ...days(windDay, DAYS - 1)]),
      windGust: layer('wmoUnit:km_h-1', [...gustDay1, ...days(gustDay, DAYS - 1)]),
      probabilityOfPrecipitation: layer('wmoUnit:percent', [
        ...popDay1,
        ...popDay2,
        ...days(popDay, DAYS - 2),
      ]),
      quantitativePrecipitation: layer('wmoUnit:mm', [
        ...qpfDay1,
        ...qpfDay2,
        ...days(qpfDay, DAYS - 2),
      ]),
      mixingHeight: layer('wmoUnit:m', days(mixDay, DAYS)),
      weather: { values: [] },
      hazards: { values: [] },
    },
  };
}

const STATIONS = [
  { id: 'KADG', name: 'Adrian, Lenawee County Airport', lng: -84.0773, lat: 41.8676, elev: 243.2 },
  { id: 'KTTF', name: 'Monroe, Custer Airport', lng: -83.4349, lat: 41.9399, elev: 187.1 },
  { id: 'KTOL', name: 'Toledo Express Airport', lng: -83.8078, lat: 41.5868, elev: 208.2 },
];

function stationsBody() {
  return {
    '@context': ctx,
    type: 'FeatureCollection',
    features: STATIONS.map((s) => ({
      id: `${NWS}/stations/${s.id}`,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        '@id': `${NWS}/stations/${s.id}`,
        '@type': 'wx:ObservationStation',
        elevation: { unitCode: 'wmoUnit:m', value: s.elev },
        stationIdentifier: s.id,
        name: s.name,
        timeZone: 'America/Detroit',
        forecast: `${NWS}/zones/forecast/MIZ082`,
        county: `${NWS}/zones/county/MIC091`,
        fireWeatherZone: `${NWS}/zones/fire/MIZ082`,
      },
    })),
    observationStations: STATIONS.map((s) => `${NWS}/stations/${s.id}`),
    pagination: { next: `${NWS}/gridpoints/DTX/31,40/stations?cursor=eyJzIjozfQ` },
  };
}

function observation(
  s: (typeof STATIONS)[number],
  ms: number,
  v: {
    tempC: number;
    dewC: number;
    windKmh: number;
    gustKmh: number | null;
    dir: number | null;
    rh: number;
    precipMm: number | null;
  },
) {
  const ts = at(ms);
  const id = `${NWS}/stations/${s.id}/observations/${ts}`;
  const q = (unitCode: string, value: number | null, qc = 'V') => ({
    unitCode,
    value,
    qualityControl: qc,
  });
  return {
    id,
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: {
      '@id': id,
      '@type': 'wx:ObservationStation',
      elevation: { unitCode: 'wmoUnit:m', value: s.elev },
      station: `${NWS}/stations/${s.id}`,
      stationId: s.id,
      stationName: s.name,
      timestamp: ts,
      rawMessage: '',
      textDescription: 'Clear',
      presentWeather: [],
      temperature: q('wmoUnit:degC', v.tempC),
      dewpoint: q('wmoUnit:degC', v.dewC),
      windDirection: q('wmoUnit:degree_(angle)', v.dir),
      windSpeed: q('wmoUnit:km_h-1', v.windKmh),
      windGust: q('wmoUnit:km_h-1', v.gustKmh, v.gustKmh === null ? 'Z' : 'V'),
      barometricPressure: q('wmoUnit:Pa', 102030),
      seaLevelPressure: q('wmoUnit:Pa', null, 'Z'),
      visibility: q('wmoUnit:m', 16090),
      maxTemperatureLast24Hours: q('wmoUnit:degC', null),
      minTemperatureLast24Hours: q('wmoUnit:degC', null),
      precipitationLastHour: q('wmoUnit:mm', v.precipMm, v.precipMm === null ? 'Z' : 'V'),
      precipitationLast3Hours: q('wmoUnit:mm', null, 'Z'),
      precipitationLast6Hours: q('wmoUnit:mm', null, 'Z'),
      relativeHumidity: q('wmoUnit:percent', v.rh),
      windChill: q('wmoUnit:degC', null, 'V'),
      heatIndex: q('wmoUnit:degC', null, 'V'),
      cloudLayers: [{ base: { unitCode: 'wmoUnit:m', value: 3660 }, amount: 'FEW' }],
    },
  };
}

function observationsBody(s: (typeof STATIONS)[number]) {
  const anchor = Date.parse(ANCHOR);
  // Hourly METARs at :53, newest first, for the six hours before the anchor.
  const rows = [
    { tempC: 8.3, dewC: 3.9, windKmh: 11.16, gustKmh: 22.32, dir: 260, rh: 73.9, precipMm: 0 },
    { tempC: 6.7, dewC: 3.9, windKmh: 7.56, gustKmh: null, dir: 240, rh: 82.3, precipMm: 0 },
    { tempC: 5.0, dewC: 3.3, windKmh: 5.4, gustKmh: null, dir: 200, rh: 89.0, precipMm: null },
    { tempC: 4.4, dewC: 3.3, windKmh: 0, gustKmh: null, dir: null, rh: 92.7, precipMm: null },
    { tempC: 4.4, dewC: 3.9, windKmh: 3.6, gustKmh: null, dir: 180, rh: 96.6, precipMm: null },
    { tempC: 5.0, dewC: 3.9, windKmh: 5.4, gustKmh: null, dir: 170, rh: 92.8, precipMm: null },
  ];
  return {
    '@context': ctx,
    type: 'FeatureCollection',
    features: rows.map((v, i) => observation(s, anchor - (i + 1) * HOUR + 53 * 60_000, v)),
  };
}

function pointBody() {
  const { lat, lng } = REPLAY_POINT;
  const id = `${NWS}/points/${lat},${lng}`;
  const grid = `${NWS}/gridpoints/${REPLAY_GRID.wfo}/${REPLAY_GRID.x},${REPLAY_GRID.y}`;
  return {
    '@context': ctx,
    id,
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      '@id': id,
      '@type': 'wx:Point',
      cwa: REPLAY_GRID.wfo,
      forecastOffice: `${NWS}/offices/${REPLAY_GRID.wfo}`,
      gridId: REPLAY_GRID.wfo,
      gridX: REPLAY_GRID.x,
      gridY: REPLAY_GRID.y,
      forecast: `${grid}/forecast`,
      forecastHourly: `${grid}/forecast/hourly`,
      forecastGridData: grid,
      observationStations: `${grid}/stations`,
      relativeLocation: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-84.037, 41.8975] },
        properties: {
          city: 'Adrian',
          state: 'MI',
          distance: { unitCode: 'wmoUnit:m', value: 610.4 },
          bearing: { unitCode: 'wmoUnit:degree_(angle)', value: 101 },
        },
      },
      forecastZone: `${NWS}/zones/forecast/MIZ082`,
      county: `${NWS}/zones/county/MIC091`,
      fireWeatherZone: `${NWS}/zones/fire/MIZ082`,
      timeZone: 'America/Detroit',
      radarStation: 'KDTX',
    },
  };
}

function fixture(
  stream: string,
  reference: string,
  exchanges: ReplayFixture['exchanges'],
): ReplayFixture {
  return {
    format: 1,
    source: 'nws',
    stream,
    kind: 'doc-derived',
    reference: `${reference}. ${VALUES}`,
    anchor: ANCHOR,
    shiftStepSeconds: STEP,
    exchanges,
  };
}

const geo = { 'content-type': 'application/geo+json' };

/** Relative path under ./doc-derived/ -> fixture. */
export function buildNwsDocDerivedFixtures(): Record<string, ReplayFixture> {
  const grid = `/gridpoints/${REPLAY_GRID.wfo}/${REPLAY_GRID.x},${REPLAY_GRID.y}`;
  return {
    'points/01-point.json': fixture(
      'points',
      `${REF}: GET /points/{latitude},{longitude} (PointGeoJson)`,
      [
        {
          request: { method: 'GET', path: `/points/${REPLAY_POINT.lat},${REPLAY_POINT.lng}` },
          response: { status: 200, headers: geo, body: pointBody() },
        },
      ],
    ),
    'stations/01-gridpoint-stations.json': fixture(
      'stations',
      `${REF}: GET /gridpoints/{wfo}/{x},{y}/stations (ObservationStationCollectionGeoJson)`,
      [
        {
          request: { method: 'GET', path: `${grid}/stations` },
          response: { status: 200, headers: geo, body: stationsBody() },
        },
      ],
    ),
    'forecast/01-gridpoint.json': fixture(
      'forecast',
      `${REF}: GET /gridpoints/{wfo}/{x},{y} (GridpointGeoJson, GridpointQuantitativeValueLayer, ISO8601Interval)`,
      [
        {
          request: { method: 'GET', path: grid },
          response: { status: 200, headers: geo, body: gridpointBody() },
        },
      ],
    ),
    'observations/01-station-observations.json': fixture(
      'observations',
      `${REF}: GET /stations/{stationId}/observations (ObservationCollectionGeoJson, QuantitativeValue)`,
      STATIONS.map((s) => ({
        request: { method: 'GET', path: `/stations/${s.id}/observations` },
        response: { status: 200, headers: geo, body: observationsBody(s) },
      })),
    ),
  };
}
