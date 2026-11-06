/**
 * The data-rights column of /admin/connectors' Deere org table (D17, decision 2a-10;
 * docs/contracts-2a.md §4.4, §1.2: rights-usage's assigned line in ./health-cards.tsx). Server
 * only. Each org the current mode has seen gets the gate's own answer (`orgReadDecision`, the
 * predicate every Deere per-org loop calls) with this page's home org and the agreements on file:
 *
 *   home      your own org: always read
 *   agreed    its customer party has an agreement in force: read in every mode
 *   blocked   sandbox / live with no agreement (or the home org unknown): not read
 *   reported  sim / replay with no agreement: read here (the demo's customers are fake), and
 *             blocked once the connection is live
 *
 * An org with no customer party yet (no ('deere', 'party', org, org) link and no farm of it
 * linked to one client) offers "link to customer" (./org-rights-actions.ts), so an agreement
 * can be recorded on the party before the first fields sync.
 */
import { orgReadDecision } from '../../../connectors/deere/rights';
import type { Mode } from '../../../connectors/types';
import type { Executor } from '../../../db/exec';
import {
  type CustomerPartyOption,
  customerPartyOptions,
  type DeereOrgParty,
  deereOrgParties,
} from '../../../db/queries/agreements';

export type OrgRightsState = 'home' | 'agreed' | 'blocked' | 'reported';

export interface OrgRightsView {
  orgId: string;
  state: OrgRightsState;
  /** What the cell says. */
  label: string;
  /** The customer party the gate resolves for this org (null = none yet). */
  party: { id: string; name: string; linkedBy: 'ref' | 'farms' } | null;
  /** Offer "link to customer": not the home org, and no party resolves yet. */
  canLink: boolean;
}

/** One org's view (pure): the gate's decision in words. */
export function orgRightsView(
  orgId: string,
  ctx: { mode: Mode; homeOrgId: string | null; party: DeereOrgParty | undefined },
): OrgRightsView {
  const agreed = (ctx.party?.agreementsInForce ?? 0) > 0;
  const decision = orgReadDecision(orgId, [], {
    mode: ctx.mode,
    homeOrgId: ctx.homeOrgId,
    agreedOrgIds: new Set(agreed ? [orgId] : []),
  });
  const party = ctx.party
    ? { id: ctx.party.partyId, name: ctx.party.partyName, linkedBy: ctx.party.linkedBy }
    : null;
  switch (decision.reason) {
    case 'home':
      return { orgId, state: 'home', label: 'your own org: always read', party, canLink: false };
    case 'agreed':
      return { orgId, state: 'agreed', label: 'agreement on file', party, canLink: false };
    case 'reported':
      return {
        orgId,
        state: 'reported',
        label: 'no agreement: blocked in live',
        party,
        canLink: party === null,
      };
    case 'home_unknown':
      return {
        orgId,
        state: 'blocked',
        label: 'blocked: home org unknown (set DEERE_HOME_ORG_ID) and no agreement',
        party,
        canLink: party === null,
      };
    default:
      return {
        orgId,
        state: 'blocked',
        label: `no agreement: blocked (${ctx.mode})`,
        party,
        canLink: party === null,
      };
  }
}

export interface OrgRightsSnapshot {
  views: Map<string, OrgRightsView>;
  /** Parties "link to customer" offers (role customer, orgs first). */
  customers: CustomerPartyOption[];
}

/** Every listed org's view, and the customers to link to (two small reads). */
export async function loadOrgRights(
  ex: Executor,
  ctx: { mode: Mode; homeOrgId: string | null; orgIds: readonly string[] },
): Promise<OrgRightsSnapshot> {
  const [parties, customers] = await Promise.all([
    deereOrgParties(ex, ctx.orgIds),
    customerPartyOptions(ex),
  ]);
  const views = new Map<string, OrgRightsView>();
  for (const orgId of ctx.orgIds) {
    views.set(
      orgId,
      orgRightsView(orgId, { mode: ctx.mode, homeOrgId: ctx.homeOrgId, party: parties.get(orgId) }),
    );
  }
  return { views, customers };
}
