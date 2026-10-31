/**
 * The Deere stand-in's org-approval knob (1f decision 5, docs/contracts-1f.md §7.1; owner:
 * sync-health), served at `${VENDOR_SIM_URL}/_control/vendor/deere/connections` behind the
 * stand-in's loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/deere/connections   -> DeereSimConnectionsStatus
 *   POST /_control/vendor/deere/connections   DeereSimConnectionsRequest -> DeereSimConnectionsStatus
 *
 * Each simulated org is `connected` (the default) or refused, as Deere refuses it:
 *  - `needs_approval`: the org hasn't approved the app in Deere Connections. GET /organizations
 *    gives it a `connections` link (and no `manage_connections`); every call naming it (a
 *    /platform/organizations/{org}/… path, or the Equipment API's `organizationIds`) answers
 *    Deere's 403 "Access Denied".
 *  - `terms`: a Required Customer Action: 403 "Requested org is in a restricted state" with
 *    `X-Deere-Terms-Location` (the terms page to accept); the listing stays connected.
 *  - `scope`: the app's grant lacks a scope or the API's licence: 403 "The client does not have
 *    a proper access for this API" (the app's configuration, not the org's).
 * Kept in the stand-in's state file (`state.vendors['deere.connections']`); /_control/reset
 * clears it. Types and zod only (no server code): /admin/connectors imports this module.
 */
import { z } from 'zod';

export const DEERE_SIM_ORG_STATES = ['connected', 'needs_approval', 'terms', 'scope'] as const;
export type DeereSimOrgState = (typeof DEERE_SIM_ORG_STATES)[number];

export const DEERE_SIM_ORG_STATE_LABELS: Record<DeereSimOrgState, string> = {
  connected: 'Connected',
  needs_approval: 'Needs approval',
  terms: "Deere's terms to accept",
  scope: 'Missing scope or licence',
};

/** Path of the knob below VENDOR_SIM_URL. */
export const DEERE_SIM_CONNECTIONS_CONTROL_PATH = '/_control/vendor/deere/connections';

export const deereSimConnectionsRequestSchema = z.strictObject({
  orgId: z.string().min(1).max(200),
  state: z.enum(DEERE_SIM_ORG_STATES),
});
export type DeereSimConnectionsRequest = z.infer<typeof deereSimConnectionsRequestSchema>;

export const deereSimConnectionsStatusSchema = z.object({
  orgs: z.array(
    z.object({ id: z.string(), name: z.string(), state: z.enum(DEERE_SIM_ORG_STATES) }),
  ),
});
export type DeereSimConnectionsStatus = z.infer<typeof deereSimConnectionsStatusSchema>;
