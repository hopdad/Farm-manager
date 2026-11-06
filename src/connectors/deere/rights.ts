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
 * The rule, in order (`orgReadDecision`):
 *   1. no rights (null or undefined: tests, tools)              -> read     ('no_rights')
 *   2. the home org (deereHomeOrg over this run's listing)      -> read     ('home')
 *   3. an org whose customer party has an unrevoked agreement   -> read     ('agreed')
 *   4. sim or replay                                            -> read     ('reported')
 *   5. sandbox, live (and anything else: fail closed), with the home org known -> refused
 *      ('no_agreement'); with it unknown (DEERE_HOME_ORG_ID unset and not exactly one member
 *      org) -> refused ('home_unknown'): no org is "the home org", so the farm's own org is
 *      refused too until DEERE_HOME_ORG_ID names it (/admin/connectors asks for it).
 *
 * Owned by the rights-usage builder. The signatures of `orgReadAllowed`, `loadOrgReadRights`,
 * `blockedOrgAccess` and `NO_AGREEMENT_DETAIL` are frozen (additive changes only); the call
 * sites above are integrator-owned.
 */
import type { Executor } from '../../db/exec';
import { agreedDeereOrgIds } from '../../db/queries/agreements';
import type { Mode } from '../types';
import { type DeereOrgAccess, deereHomeOrg, deereOrgAccess } from './orgs';
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
 * Why an org is refused while the home org is unknown (sandbox or live, DEERE_HOME_ORG_ID unset,
 * several member orgs): logs and /admin/connectors.
 */
export const HOME_ORG_UNKNOWN_DETAIL =
  'home org unknown: set DEERE_HOME_ORG_ID (D17: until then every org without a data-rights agreement is refused, your own included)';

/** Modes where the gate only reports (the demo's customers are fake). Every other mode enforces. */
export const GATE_REPORTED_MODES: readonly Mode[] = ['sim', 'replay'];

/** Is the gate enforced in this mode? Sandbox and live (and off: fail closed). */
export function gateEnforced(mode: Mode): boolean {
  return !GATE_REPORTED_MODES.includes(mode);
}

/** Why an org may or may not be read (see the file header for the order). */
export type OrgReadReason =
  | 'no_rights'
  | 'home'
  | 'agreed'
  | 'reported'
  | 'no_agreement'
  | 'home_unknown';

export interface OrgReadDecision {
  allowed: boolean;
  reason: OrgReadReason;
}

/** The gate's full answer for one org (`orgReadAllowed` is its `allowed`). Pure. */
export function orgReadDecision(
  orgId: string,
  listing: readonly { id: string; member?: boolean }[],
  rights: OrgReadRights | null | undefined,
): OrgReadDecision {
  if (!rights) return { allowed: true, reason: 'no_rights' };
  const home = deereHomeOrg(rights.mode, rights.homeOrgId, listing);
  if (home.orgId !== null && home.orgId === orgId) return { allowed: true, reason: 'home' };
  if (rights.agreedOrgIds.has(orgId)) return { allowed: true, reason: 'agreed' };
  if (!gateEnforced(rights.mode)) return { allowed: true, reason: 'reported' };
  return { allowed: false, reason: home.orgId === null ? 'home_unknown' : 'no_agreement' };
}

/**
 * May this run read `orgId`'s data? The home org always (deereHomeOrg over this run's
 * `listing`, GET /organizations); another org in sandbox and live only when it is in
 * `rights.agreedOrgIds`; in sim and replay always. With the home org unknown in sandbox or live
 * (DEERE_HOME_ORG_ID unset, not exactly one member org) it FAILS CLOSED: every org without an
 * agreement is refused, the farm's own included (logged; /admin/connectors asks for
 * DEERE_HOME_ORG_ID). No rights (null or undefined: tests, tools) = allowed.
 */
export function orgReadAllowed(
  orgId: string,
  listing: readonly { id: string; member?: boolean }[],
  rights: OrgReadRights | null | undefined,
): boolean {
  return orgReadDecision(orgId, listing, rights).allowed;
}

/** The log / page text for a refusal reason (null when the org is read). */
export function orgRefusalDetail(reason: OrgReadReason): string | null {
  if (reason === 'home_unknown') return HOME_ORG_UNKNOWN_DETAIL;
  if (reason === 'no_agreement') return NO_AGREEMENT_DETAIL;
  return null;
}

/**
 * How a blocked org is reported in the run's org list (stored in ingest.connector_orgs by
 * fleet.deere, whose status CHECK allows connected / needs_approval): needs approval, with
 * NO_AGREEMENT_DETAIL (or the detail given: `orgRefusalDetail` of the decision).
 */
export function blockedOrgAccess(
  org: {
    id: string;
    name?: string;
    links?: readonly DeereLink[];
  },
  detail: string = NO_AGREEMENT_DETAIL,
): DeereOrgAccess {
  return { ...deereOrgAccess(org), status: 'needs_approval', detail };
}

/**
 * The run's rights, read once per job run: one read-only query over the unrevoked agreements
 * and the org -> party links, resolved the way `customerOrgParty` resolves them (the ('deere',
 * 'party', <org>, <org>) ref, else the one client party every farm of that org shares; never a
 * wider rule, never a write). A database failure throws: the job's run fails rather than read
 * customer data it may not.
 */
export async function loadOrgReadRights(
  ex: Executor,
  mode: Mode,
  homeOrgId: string | null,
): Promise<OrgReadRights> {
  return { mode, homeOrgId, agreedOrgIds: await agreedDeereOrgIds(ex) };
}
