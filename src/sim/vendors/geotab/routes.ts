/**
 * MyGeotab stand-in (mounted at /geotab; slice 1f.2, owner: the trucks builder,
 * docs/contracts-1f.md part B): JSON-RPC at POST /geotab/apiv1 (Authenticate with
 * SIM_CREDENTIALS.geotab, GetFeed for LogRecord / StatusData / FaultData with fromVersion →
 * toVersion, the GetFeed 60/min and Authenticate 10/min limits) for the Geotab vehicles of the
 * demo world (`simTelematicsMachines(farm, 'geotab')`: the hired hauler H2).
 *
 * Foundation stub: answers every request 404 "not simulated".
 */
import type { VendorModule } from '../context';
import { json } from '../http';

function geotabError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { error: { name: 'JSONRPCError', message } }, headers);
}

export const geotabModule: VendorModule = {
  vendor: 'geotab',
  error: geotabError,
  handle(req) {
    return geotabError(404, `Not found: ${req.path} (not simulated)`);
  },
};
