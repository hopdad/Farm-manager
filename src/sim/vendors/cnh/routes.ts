/**
 * CNH FieldOps stand-in (mounted at /cnh; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): CNH's own paths and shapes from its published OpenAPI
 * (SwaggerHub CNH/FieldOps-API 1.0.0, read Oct 30, 2026) for the demo's Case IH machines
 * (`simTelematicsMachines(farm, 'cnh')`: C3, T1, by VIN, in company SIM_CNH_COMPANY_ID):
 *
 *   /cnh/identity/authorize, /oauth/token, /oauth/revoke   Auth0: response_type, scope
 *       (offline_access), state, client_id, redirect_uri, audience and connection all required
 *       (SIM_CNH_AUTH); client_secret_post; the refresh grant sends redirect_uri too
 *   /cnh/v1/companies, /UserProfile, /companies/{id}/overview, …/boundaries (JSON)
 *   /cnh/v1/equipment, /equipment/{vin} (JSON; no paging), /equipment/{vin}/metrics (cursor)
 *   /cnh/v1/Fleet/{page}, /Fleet/Equipment/{vin}/{Series}/{startUTC}/{endUTC}/{page} (XML in
 *       the ISO 15143-3 namespace, lower-case location keys; Locations, CumulativeOperatingHours,
 *       Distance, FuelRemainingRatio, DEFRemaining, EngineCondition, CautionCodes, Faults)
 * Every API call needs `Authorization: Bearer` AND `Ocp-Apim-Subscription-Key`; the states a
 * real connection meets, with knobs under /_control/vendor/cnh/…: a VIN without an accepted
 * EULA (403 "EULA not accepted for the VIN. Login to FieldOps to accept EULA."; vehicle info
 * still answers), a wrong key or environment (APIM's 401 with `WWW-Authenticate:
 * AzureApiManagementKey`), an expired token (401), 429 with an integer Retry-After.
 * Error bodies: APIM `{ statusCode, message }`; the API's `{ message, statusCode, requestId,
 * errorMessages }`.
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
