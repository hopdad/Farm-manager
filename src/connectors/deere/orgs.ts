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
 * The rel name is doc-derived (Deere's Connections docs, unconfirmed): confirm with
 * `pnpm connectors:record`. Owned by the 1f foundation (contract file).
 */
import { VendorHttpError } from '../http';
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
