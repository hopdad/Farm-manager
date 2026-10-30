/**
 * ISO 15143-3 (AEMP 2.0) stand-in (mounted at /aemp; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): one provider per path prefix, /aemp/<provider>/Fleet/{pageNumber}
 * (and the fault time series), for SIM_AEMP_PROVIDERS: `cnh` (the Case IH combine and tractor,
 * until CNH FieldOps' own shapes are confirmed), `kubota` (the loader) and `samsara` (Samsara's
 * asset-gateway machines, the first live target): `simTelematicsMachines(farm, 'aemp',
 * { provider })`. JSON or XML per the provider's format; bearer SIM_CREDENTIALS.aemp.token.
 *
 * Foundation stub: answers every request 404 "not simulated".
 */
import type { VendorModule } from '../context';
import { json } from '../http';

function aempError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { message }, headers);
}

export const aempModule: VendorModule = {
  vendor: 'aemp',
  error: aempError,
  handle(req) {
    return aempError(404, `Not found: ${req.path} (not simulated)`);
  },
};
