/**
 * Terminal stand-in (mounted at /terminal; slice 1f.2, owner: the terminal-pickups builder,
 * docs/contracts-1f.md part B): the normalized API under /terminal/tsp/v1 (Authorization: Bearer
 * SIM_CREDENTIALS.terminal.secretKey, Connection-Token header): /providers, vehicles, latest and
 * historical vehicle locations, stats and fault code events for the Terminal vehicles of the
 * demo world (`simTelematicsMachines(farm, 'terminal')`; none in the 1f.2 fleet yet: the
 * builder adds a hired truck in its own pure function, as deere-data adds its Deere-only field).
 *
 * Foundation stub: answers every request 404 "not simulated".
 */
import type { VendorModule } from '../context';
import { json } from '../http';

function terminalError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(
    status,
    { error: { code: status === 404 ? 'not_found' : 'error', message } },
    headers,
  );
}

export const terminalModule: VendorModule = {
  vendor: 'terminal',
  error: terminalError,
  handle(req) {
    return terminalError(404, `Not found: ${req.path} (not simulated)`);
  },
};
