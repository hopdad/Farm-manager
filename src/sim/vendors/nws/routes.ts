/**
 * NWS stand-in (mounted at /nws). PLACEHOLDER: the weather builder (slice 1b) replaces this
 * module (keep the export `nwsModule`): api.weather.gov-shaped `/points/{lat},{lon}`,
 * `/gridpoints/{wfo}/{x},{y}` and station observations computed from the simulated world, plus
 * the wind override for the spray demo through `control` (served at /_control/vendor/nws/…).
 */
import type { VendorModule } from '../context';
import { json } from '../http';

function nwsError(status: number, message: string, headers: Record<string, string> = {}) {
  // api.weather.gov answers errors as application/problem+json.
  return json(
    status,
    { title: message, status, detail: message },
    {
      'content-type': 'application/problem+json',
      ...headers,
    },
  );
}

export const nwsModule: VendorModule = {
  vendor: 'nws',
  error: nwsError,
  handle: (req) => nwsError(404, `NWS stand-in not built yet (slice 1b): ${req.path}`),
};
