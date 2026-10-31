/**
 * Deere org access (1f decision 5, docs/contracts-1f.md §5.4): which organizations a Deere
 * connection may sync from. Pure helpers shared by every Deere sync (locations, fields,
 * operations, the backfill) so they skip the same orgs the same way:
 *
 *  - an org whose listing (GET /organizations) carries a `connections` link has not approved
 *    this app in Deere Connections yet: `needs_approval`, with that link as the approval URL;
 *  - an org that answers 403 to an org-scoped call is `needs_approval` too (the reason is kept);
 *  - every other org is `connected`.
 *
 * A needs-approval org is SKIPPED (logged, recorded in ingest.connector_orgs by sync-health) and
 * never fails the other orgs' sync. Customer orgs are connected only after a data-rights
 * agreement (plan 2a, D17): /admin/connectors says so; nothing here blocks the home org.
 *
 * The home org (decision 8, `deereHomeOrg`): the org that is your own operation. Machines are
 * created only from it; farms and fields read from any other org belong to that org's customer
 * (farms.client_party_id = the org's party). DEERE_HOME_ORG_ID names it; unset, sim and replay
 * use their simulated home org and sandbox/live the only org you are a member of (none when
 * there are several: /admin/connectors asks for the setting).
 *
 * The rel name is doc-derived (Deere's Connections docs, unconfirmed): confirm with
 * `pnpm connectors:record`. Owned by the 1f foundation (contract file).
 */
import { SIM_DEERE_HOME_ORG } from '../../sim/types';
import { VendorHttpError } from '../http';
import type { Mode } from '../types';
import type { DeereLink } from './schemas';

/** Link rel on an organization that still needs approval (Deere's Connections docs). */
export const DEERE_CONNECTIONS_REL = 'connections';
/**
 * Link rels of a CONNECTED organization (where its connection is managed). Deere's docs spell
 * it both ways; either one means the org already approved the app.
 */
export const DEERE_MANAGE_CONNECTIONS_RELS = ['manage_connections', 'manage_connection'] as const;

/**
 * Why Deere refused an org-scoped call (403). Deere's 403 is not always "needs approval": an
 * `x-deere-terms-location` header means terms must be accepted at that URL, and a body naming a
 * missing scope or license is the app's configuration (a re-consent with DEERE_SCOPES, or the
 * API's licence in My Applications), not the org's.
 */
export type DeereDenial = 'needs_approval' | 'terms' | 'scope';

export function deereDenialOf(err: VendorHttpError): DeereDenial {
  if (err.headers?.['x-deere-terms-location']) return 'terms';
  if (/\b(scope|licen[cs]e|proper access)\b/i.test(err.detail ?? '')) return 'scope';
  return 'needs_approval';
}

export const DEERE_ORG_STATUSES = ['connected', 'needs_approval'] as const;
export type DeereOrgStatus = (typeof DEERE_ORG_STATUSES)[number];

/** One org as a sync saw it (the shape ingest.connector_orgs stores). */
export interface DeereOrgAccess {
  orgId: string;
  name: string | null;
  status: DeereOrgStatus;
  /** Where a person approves the connection (the `connections` link), when known. */
  approvalUrl: string | null;
  /** Where a connected org's connection is managed (`manage_connections`), when listed. */
  manageUrl?: string | null;
  /** Short reason when not connected ("403 from /organizations/{id}/fields"), no secrets. */
  detail: string | null;
}

/** Classify an org from its listing entry (GET /organizations). */
export function deereOrgAccess(org: {
  id: string;
  name?: string;
  links?: readonly DeereLink[];
}): DeereOrgAccess {
  const link = org.links?.find((l) => l.rel === DEERE_CONNECTIONS_REL);
  const manage = org.links?.find((l) =>
    (DEERE_MANAGE_CONNECTIONS_RELS as readonly string[]).includes(l.rel),
  );
  return {
    orgId: org.id,
    name: org.name ?? null,
    status: link ? 'needs_approval' : 'connected',
    approvalUrl: link?.uri ?? null,
    manageUrl: link ? null : (manage?.uri ?? null),
    detail: link ? 'the organization has not approved this app (Deere Connections)' : null,
  };
}

/**
 * True when `err` is Deere refusing an org-scoped call (403). Most mean the org needs approval;
 * `deereDenialOf(err)` tells terms and missing scopes apart (shown differently on /admin).
 */
export function isDeereOrgDenied(err: unknown): err is VendorHttpError {
  return err instanceof VendorHttpError && err.vendor === 'deere' && err.status === 403;
}

/** The access record of an org that answered 403 (keeps the approval link if the listing had one). */
export function deniedOrgAccess(
  org: { id: string; name?: string; links?: readonly DeereLink[] },
  err: VendorHttpError,
): DeereOrgAccess {
  const base = deereOrgAccess(org);
  const why = deereDenialOf(err);
  const detail =
    why === 'terms'
      ? `403 from ${err.path}: accept Deere's terms at ${err.headers?.['x-deere-terms-location']}`
      : why === 'scope'
        ? `403 from ${err.path}: the app's scopes or API licence (${err.detail ?? 'no detail'})`
        : `403 from ${err.path}`;
  return { ...base, status: 'needs_approval', detail };
}

// ---------------------------------------------------------------------------------------------
// The home org (decision 8)
// ---------------------------------------------------------------------------------------------

/**
 * The home org of the replay fixtures: they are built from the demo farm
 * (./fixtures/build.ts), whose own operation is the simulated home org.
 */
export const DEERE_REPLAY_HOME_ORG = SIM_DEERE_HOME_ORG;

/** Where the home org came from (/admin/connectors shows it; `unknown` asks for the setting). */
export type DeereHomeOrgSource = 'config' | 'sim' | 'replay' | 'only_member' | 'unknown';

export interface DeereHomeOrg {
  /**
   * Null = no home org: no machine, farm or field is created from Deere until one is known
   * (`deereMayCreateRows`; 1f fix: otherwise farms created in your own org would get a customer
   * party); rows that already map through external refs are still updated.
   */
  orgId: string | null;
  source: DeereHomeOrgSource;
}

/**
 * Whether a Deere sync may CREATE machines, farms and fields this run (1f fix, docs/contracts-1f.md
 * §5.4): only once the home org is known. Without one (sandbox/live, several member orgs,
 * DEERE_HOME_ORG_ID unset) the syncs still match and update rows that already have their external
 * ref, and create nothing; /admin/connectors asks for DEERE_HOME_ORG_ID.
 */
export function deereMayCreateRows(home: DeereHomeOrg): boolean {
  return home.orgId !== null;
}

/**
 * Which Deere org is your own operation. `configured` = DEERE_HOME_ORG_ID (wins in every mode);
 * `orgs` = the org listing (GET /organizations) of this run, used only in sandbox and live.
 */
export function deereHomeOrg(
  mode: Mode,
  configured: string | null | undefined,
  orgs: readonly { id: string; member?: boolean }[],
): DeereHomeOrg {
  if (configured) return { orgId: configured, source: 'config' };
  if (mode === 'sim') return { orgId: SIM_DEERE_HOME_ORG, source: 'sim' };
  if (mode === 'replay') return { orgId: DEERE_REPLAY_HOME_ORG, source: 'replay' };
  if (mode === 'off') return { orgId: null, source: 'unknown' };
  const members = orgs.filter((o) => o.member === true);
  const only = members.length === 1 ? members[0] : undefined;
  return only ? { orgId: only.id, source: 'only_member' } : { orgId: null, source: 'unknown' };
}
