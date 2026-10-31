/**
 * ISO 15143-3 (AEMP 2.0) stand-in (mounted at /aemp; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): one provider per path prefix, /aemp/<provider>/Fleet/{pageNumber}
 * (and a provider's fault time series), for SIM_AEMP_PROVIDERS: `kubota` (the loader; XML per
 * the ISO edition-1 XSDs, Kubota's real format being unknown) and `samsara` (Samsara's
 * asset-gateway machines, the first live target: JSON wrapped in `{"Fleet": …}`, `EquipmentID`
 * the stable id, no fault series, a 500 to `Accept: application/xml`, as Samsara answers):
 * `simTelematicsMachines(farm, 'aemp', { provider })`. Bearer SIM_CREDENTIALS.aemp.token. Each
 * section carries its own `datetime`; 100 machines per page; `Links` with `next` while more
 * remain. (CNH's Case IH machines have their own connection and stand-in: /cnh.)
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
