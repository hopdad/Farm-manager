/**
 * CNH FieldOps stand-in (mounted at /cnh; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): SCAFFOLDING ONLY until CNH's shapes are confirmed: the OAuth
 * flow under /cnh/identity (SIM_CREDENTIALS.cnh), the subscription-key header check, and the
 * states a real connection meets (a machine without the owner's EULA answers 403; an app still
 * in staging answering a production call), with knobs under /_control/vendor/cnh/…. Base URL
 * and paths are config of the client; no response fixtures for unconfirmed shapes.
 *
 * Foundation stub: answers every request 404 "not simulated".
 */
import type { VendorModule } from '../context';
import { json } from '../http';

function cnhError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { statusCode: status, message }, headers);
}

export const cnhModule: VendorModule = {
  vendor: 'cnh',
  error: cnhError,
  handle(req) {
    return cnhError(404, `Not found: ${req.path} (not simulated)`);
  },
};
