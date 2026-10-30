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

/** Link rel on an organization that still needs approval. // doc-derived, confirm */
export const DEERE_CONNECTIONS_REL = 'connections';

export const DEERE_ORG_STATUSES = ['connected', 'needs_approval'] as const;
export type DeereOrgStatus = (typeof DEERE_ORG_STATUSES)[number];

/** One org as a sync saw it (the shape ingest.connector_orgs stores). */
export interface DeereOrgAccess {
  orgId: string;
  name: string | null;
  status: DeereOrgStatus;
  /** Where a person approves the connection (the `connections` link), when known. */
  approvalUrl: string | null;
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
  return {
    orgId: org.id,
    name: org.name ?? null,
    status: link ? 'needs_approval' : 'connected',
    approvalUrl: link?.uri ?? null,
    detail: link ? 'the organization has not approved this app (Deere Connections)' : null,
  };
}

/** True when `err` is Deere refusing an org-scoped call (403): the org needs approval. */
export function isDeereOrgDenied(err: unknown): err is VendorHttpError {
  return err instanceof VendorHttpError && err.vendor === 'deere' && err.status === 403;
}

/** The access record of an org that answered 403 (keeps the approval link if the listing had one). */
export function deniedOrgAccess(
  org: { id: string; name?: string; links?: readonly DeereLink[] },
  err: VendorHttpError,
): DeereOrgAccess {
  const base = deereOrgAccess(org);
  return { ...base, status: 'needs_approval', detail: `403 from ${err.path}` };
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
  /** Null = no home org: no machine is created from Deere, every org's farms are customers'. */
  orgId: string | null;
  source: DeereHomeOrgSource;
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
