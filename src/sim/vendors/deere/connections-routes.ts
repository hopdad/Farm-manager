/**
 * Deere stand-in route module `connections` (1f decision 5, owner: sync-health;
 * docs/contracts-1f.md §7.1): org approval, as Deere answers it. The knob
 * (./connections-control-types.ts, `/_control/vendor/deere/connections`) sets an org to
 * `needs_approval`, `terms` or `scope`; such an org is refused before any other module or the
 * core serves it:
 *
 *  - `route()` runs first (DEERE_ROUTE_MODULES order) and answers 403 for every request that
 *    names a refused org (`r.orgIds`: the org of a /platform/organizations/{org}/… path, core
 *    paths included, or ANY org of the Equipment API's `organizationIds`: Deere refuses the whole
 *    call), with the platform's `{ errors: [...] }` body or the Equipment API's bare array;
 *    `terms` adds `X-Deere-Terms-Location`.
 *  - `orgLinks()` gives a `needs_approval` org the `connections` link (Deere's per-client
 *    `https://connections.deere.com/connections/{clientId}/select-organizations`), so the core
 *    listing drops its `manage_connections` link.
 * Every org is connected until the knob says otherwise; /_control/reset clears the knob.
 */
import { SIM_CREDENTIALS } from '../../types';
import { json, type SimResponse } from '../http';
import {
  DEERE_SIM_ORG_STATES,
  type DeereSimConnectionsStatus,
  type DeereSimOrgState,
  deereSimConnectionsRequestSchema,
} from './connections-control-types';
import { type DeereRouteModule, deereModuleState } from './modules';
import { apiError, simDeereOrgs } from './platform';

/** Deere's Connections page for a client (one URL per client, the same for every org). */
export function deereConnectionsUrl(clientId: string): string {
  return `https://connections.deere.com/connections/${encodeURIComponent(clientId)}/select-organizations`;
}

type OrgStates = Record<string, Exclude<DeereSimOrgState, 'connected'>>;

function orgStates(ctx: Parameters<typeof deereModuleState>[0]): OrgStates {
  const bag = deereModuleState(ctx, 'connections');
  const raw = bag.orgs;
  if (!raw || typeof raw !== 'object') return {};
  const out: OrgStates = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'needs_approval' || v === 'terms' || v === 'scope') out[id] = v;
  }
  return out;
}

function refusal(
  api: 'platform' | 'equipment',
  orgId: string,
  state: Exclude<DeereSimOrgState, 'connected'>,
): SimResponse {
  const message =
    state === 'terms'
      ? 'Requested org is in a restricted state'
      : state === 'scope'
        ? 'The client does not have a proper access for this API'
        : 'Access Denied';
  const headers: Record<string, string> =
    state === 'terms'
      ? {
          'x-deere-terms-location': `https://teammanager.deere.com/organizations/${encodeURIComponent(orgId)}/terms`,
          'x-deere-warning': 'Required Customer Action',
        }
      : {};
  // The Equipment API answers errors as a bare array; the platform as { errors: [...] }.
  return api === 'equipment'
    ? json(403, [{ code: '403', message }], headers)
    : apiError(403, message, headers);
}

export const deereConnectionsRoutes: DeereRouteModule = {
  key: 'connections',
  route(r) {
    const states = orgStates(r.ctx);
    for (const id of r.orgIds) {
      const state = states[id];
      if (state) return refusal(r.api, id, state);
    }
    return null;
  },
  orgLinks(org, r) {
    return orgStates(r.ctx)[org.id] === 'needs_approval'
      ? [{ rel: 'connections', uri: deereConnectionsUrl(SIM_CREDENTIALS.deere.clientId) }]
      : [];
  },
  control(req, ctx) {
    if (req.path !== '/' && req.path !== '') return null;
    const reply = (): SimResponse => {
      const states = orgStates(ctx);
      const body: DeereSimConnectionsStatus = {
        orgs: simDeereOrgs(ctx.world.farm).map((o) => ({
          id: o.id,
          name: o.name,
          state: states[o.id] ?? 'connected',
        })),
      };
      return json(200, body);
    };
    if (req.method === 'GET') return reply();
    if (req.method !== 'POST') return json(405, { error: 'GET or POST' });
    let value: unknown;
    try {
      value = JSON.parse(req.body || '{}');
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    const parsed = deereSimConnectionsRequestSchema.safeParse(value);
    if (!parsed.success) {
      return json(400, {
        error: `orgId and state (${DEERE_SIM_ORG_STATES.join(', ')}) are required`,
      });
    }
    const { orgId, state } = parsed.data;
    if (!simDeereOrgs(ctx.world.farm).some((o) => o.id === orgId)) {
      return json(404, { error: `no simulated Deere org '${orgId}'` });
    }
    const bag = deereModuleState(ctx, 'connections');
    const next = { ...orgStates(ctx) };
    if (state === 'connected') delete next[orgId];
    else next[orgId] = state;
    bag.orgs = next;
    ctx.persist();
    ctx.log(`deere connections: ${orgId} → ${state}`);
    return reply();
  },
};
