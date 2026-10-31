/**
 * Terminal stand-in (mounted at /terminal; slice 1f.2, owner: the terminal-pickups builder,
 * docs/contracts-1f.md part B): the normalized API under /terminal/tsp/v1 (Authorization: Bearer
 * SIM_CREDENTIALS.terminal.secretKey; Connection-Token per connection), as Terminal's OpenAPI
 * 3.1 (api.withterminal.com/tsp/openapi) has it: /providers (no key needed), /connections (the
 * secret key alone lists them, each with its `token`), /vehicles, /vehicles/locations (latest),
 * /vehicles/{id}/locations and /vehicles/{id}/stats/historical, /fault-codes/events; list
 * replies `{ results, next? }`; metric units (km, km/h, ms). The demo world's Terminal vehicle is
 * the hired hauler H3 (`simTelematicsMachines(farm, 'terminal')`: connection
 * SIM_TERMINAL_CONNECTION_ID, TSP `omnitracs-xrs`).
 *
 * Errors are Terminal's own flat body, `{ code, message, detail? }` (e.g. `unauthorized`,
 * `not_found`, `too_many_requests` with Retry-After, possibly fractional). `terminalError`
 * answers that shape.
 *
 * Foundation stub: answers every request 404 "not simulated".
 */
import type { VendorModule } from '../context';
import { json } from '../http';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'too_many_requests',
};

/** Terminal's error body: `{ code, message, detail? }`. */
export function terminalError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  detail?: string,
) {
  return json(
    status,
    { code: CODES[status] ?? 'internal_error', message, ...(detail ? { detail } : {}) },
    headers,
  );
}

export const terminalModule: VendorModule = {
  vendor: 'terminal',
  error: (status, message, headers) => terminalError(status, message, headers),
  handle(req) {
    return terminalError(404, `Not found: ${req.path} (not simulated)`);
  },
};
