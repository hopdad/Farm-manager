/**
 * NWS assumptions not yet confirmed against a live api.weather.gov response (plan §5 "Keeping it
 * honest"). api.weather.gov was unreachable from the build machine (Oct 29, 2026: 403 at the
 * proxy), so the client, the stand-in and the replay fixtures follow the OpenAPI document
 * (https://api.weather.gov/openapi.json, v2.0.0) and the documentation page
 * (https://www.weather.gov/documentation/services-web-api). The integrator appends these to
 * the admin list (src/connectors/doc-derived.ts, DOC_DERIVED). A recorded response
 * (`pnpm connectors:record nws`, 1f) or one run with CONNECTOR_WEATHER=live on the PC removes
 * entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const NWS_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'nws',
    what: 'gridpoint layer and observation unit codes (wmoUnit:degC, km_h-1, mm, m, percent, degree_(angle))',
    confirm:
      'the exact uom strings of temperature, windSpeed, windGust, quantitativePrecipitation, mixingHeight, transportWindSpeed (an unknown unit dead-letters the forecast)',
    file: 'src/connectors/nws/units.ts',
  },
  {
    source: 'nws',
    what: 'quantitativePrecipitation over multi-hour validTime intervals',
    confirm: 'that the value is the interval total (the mapper spreads it evenly over its hours)',
    file: 'src/connectors/nws/mapper.ts',
  },
  {
    source: 'nws',
    what: 'GET /points/{lat},{lon} with at most 4 decimals',
    confirm: 'that more precise points answer 301 to the rounded point (the client rounds first)',
    file: 'src/connectors/nws/client.ts',
  },
  {
    source: 'nws',
    what: 'observation properties stationId / stationName',
    confirm: 'present in current responses (else the id is taken from the station URI)',
    file: 'src/connectors/nws/schemas.ts',
  },
  {
    source: 'nws',
    what: 'requests without a User-Agent are refused (the stand-in answers 403)',
    confirm: 'status code and body NWS returns',
    file: 'src/sim/vendors/nws/routes.ts',
  },
];
