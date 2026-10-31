/**
 * MyGeotab stand-in (mounted at /geotab; slice 1f.2, owner: the trucks builder,
 * docs/contracts-1f.md part B): JSON-RPC at POST /geotab/apiv1 (Authenticate with
 * SIM_CREDENTIALS.geotab, sent on the wire as `userName`; GetFeed for LogRecord / StatusData /
 * FaultData with fromVersion → toVersion, one version counter per entity type; the GetFeed
 * 60/min per entity type and Authenticate 10/min limits) for the Geotab vehicles of the demo
 * world (`simTelematicsMachines(farm, 'geotab')`: the hired hauler H2).
 *
 * Errors are MyGeotab's own (my.geotab.com/api.json; live-checked): HTTP 200 with a JSON-RPC
 * error object, `{ error: { code, message, data: { id, type, requestIndex } }, jsonrpc: '2.0' }`,
 * told apart by `data.type` (`InvalidUserException`, `OverLimitException` with a Retry-After
 * header, `MissingMethodException`); `name` is deprecated. `geotabError` answers that shape.
 *
 * Foundation stub: answers every request with a MissingMethodException ("not simulated").
 */
import { randomUUID } from 'node:crypto';
import type { VendorModule } from '../context';
import { json } from '../http';

/** A MyGeotab JSON-RPC error (always HTTP 200; the client switches on `error.data.type`). */
export function geotabError(
  type: string,
  message: string,
  headers: Record<string, string> = {},
  status = 200,
) {
  return json(
    status,
    {
      error: { code: -32000, message, data: { id: randomUUID(), type, requestIndex: 0 } },
      jsonrpc: '2.0',
    },
    headers,
  );
}

export const geotabModule: VendorModule = {
  vendor: 'geotab',
  // Fault injection (http_error, rate_limit) keeps the HTTP status it asks for.
  error: (status, message, headers) =>
    geotabError(
      status === 429 ? 'OverLimitException' : 'GenericException',
      message,
      headers,
      status,
    ),
  handle(req) {
    return geotabError('MissingMethodException', `Not found: ${req.path} (not simulated)`);
  },
};
