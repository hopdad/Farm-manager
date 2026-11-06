/**
 * The data-rights gate for Deere customer orgs (D17, decision 2a-10; docs/contracts-2a.md
 * §4.4): a Deere org other than the home org is read only when its customer party (the party
 * `customerOrgParty` resolves: the ('deere', 'party', <org>, <org>) ref, else the client party
 * the org's farms share) has an unrevoked farm.data_rights_agreements row. ENFORCED in sandbox
 * and live; in sim and replay it is only REPORTED (the demo's customers are fake): /admin/
 * connectors shows each customer org as "agreement on file" or "no agreement: blocked in live".
 *
 * ONE predicate, called in every Deere per-org loop before the org's data is read:
 *   - locations       DeereClient.pollLocationsWithOrgs   (src/connectors/deere/client.ts)
 *   - fields sync     DeereFieldsRun.orgs                  (src/connectors/deere/fields/sync.ts)
 *   - fields client   DeereFieldsApi.connectedOrgs         (src/connectors/deere/fields/client.ts)
 *   - operations      pollDeereOperations                  (src/connectors/deere/ops/poll.ts)
 * The jobs (fleet.deere, deere.fields, deere.ops) load the run's rights once with
 * `loadOrgReadRights` and pass them in. CNH companies are machines only: not gated.
 *
 * FOUNDATION STUB, owned by the rights-usage builder: `orgReadAllowed` always answers true and
 * `loadOrgReadRights` reads nothing. The signatures are frozen (additive changes only); the
 * call sites above are integrator-owned and already call them.
 */
import type { Executor } from '../../db/exec';
import type { Mode } from '../types';
import { type DeereOrgAccess, deereOrgAccess } from './orgs';
import type { DeereLink } from './schemas';

/** What one run knows about agreements. */
export interface OrgReadRights {
  /** The connector mode of the run: enforced in sandbox and live, reported in sim and replay. */
  mode: Mode;
  /** DEERE_HOME_ORG_ID (deereHomeOrg's `configured`; null = from the listing). */
  homeOrgId: string | null;
  /** Deere org ids whose customer party has an unrevoked agreement on file. */
  agreedOrgIds: ReadonlySet<string>;
}

/** Why a blocked org is skipped (logs, the stored org row's detail, /admin/connectors). */
export const NO_AGREEMENT_DETAIL =
  'no data-rights agreement on file (D17): customer data is read only after one is signed';

/**
 * May this run read `orgId`'s data? The home org always (deereHomeOrg over this run's
 * `listing`, GET /organizations); another org in sandbox and live only when it is in
 * `rights.agreedOrgIds`; in sim and replay always. With the home org unknown in sandbox or live
 * (DEERE_HOME_ORG_ID unset, not exactly one member org) it FAILS CLOSED: every org without an
 * agreement is refused, the farm's own included (logged; /admin/connectors asks for
 * DEERE_HOME_ORG_ID). No rights (null or undefined: tests, tools) = allowed. STUB
 * (rights-usage): always true.
 */
export function orgReadAllowed(
  _orgId: string,
  _listing: readonly { id: string; member?: boolean }[],
  _rights: OrgReadRights | null | undefined,
): boolean {
  return true;
}

/**
 * How a blocked org is reported in the run's org list (stored in ingest.connector_orgs by
 * fleet.deere, whose status CHECK allows connected / needs_approval): needs approval, with
 * NO_AGREEMENT_DETAIL.
 */
export function blockedOrgAccess(org: {
  id: string;
  name?: string;
  links?: readonly DeereLink[];
}): DeereOrgAccess {
  return { ...deereOrgAccess(org), status: 'needs_approval', detail: NO_AGREEMENT_DETAIL };
}

/**
 * The run's rights, read once per job run (agreements and the org -> party links). STUB
 * (rights-usage): no agreement on file, nothing read.
 */
export async function loadOrgReadRights(
  _ex: Executor,
  mode: Mode,
  homeOrgId: string | null,
): Promise<OrgReadRights> {
  return { mode, homeOrgId, agreedOrgIds: new Set() };
}
