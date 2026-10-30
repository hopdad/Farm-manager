/**
 * John Deere stand-in (mounted at /deere): Operations Center sign-in and machine locations,
 * computed from the simulated world. Every path below is doc-derived (see
 * src/connectors/deere/schemas.ts for what is confirmed):
 *
 *   GET/POST /oauth2/<authServerId>/v1/authorize   "Sign in to Deere (simulated)" consent page;
 *                                                  `sim_auto_consent=1` skips it (sim only, so
 *                                                  `pnpm dev` connects with no clicks)
 *   POST     /oauth2/<authServerId>/v1/token       authorization_code + refresh_token grants;
 *                                                  short-lived access tokens, ROTATING refresh
 *                                                  tokens (a used one is invalid_grant)
 *   GET      /platform/organizations               orgs the token can see
 *   GET      /platform/organizations/{org}/machines
 *                                                  with equipmentType / equipmentMake /
 *                                                  equipmentModel (1f; doc-derived, confirm)
 *   GET      /platform/organizations/{org}/fields  the org's demo fields (1f minimal listing,
 *                                                  ./platform.ts simDeereFields; the fields
 *                                                  module shadows it with the full shape)
 *   GET      /platform/machines/{id}/breadcrumbs?startDate=&endDate=&pageOffset=&itemLimit=
 *                                                  positions only while WORKING (plan §5)
 *
 * Each org's data is served under that org id (contracts §9), so the org a sync reads from is
 * the external_refs source_org it looks up.
 *
 * 1f: every other platform path goes to the route modules (./modules.ts: connections, fields,
 * ops; one per builder, docs/contracts-1f.md §7), which run before the core routes; their knobs
 * are served at /_control/vendor/deere/<key>/....
 */
import { timingSafeEqual } from 'node:crypto';
import {
  DEERE_AUTH_SERVER_ID,
  DEERE_MEDIA_TYPE,
  type DeereBreadcrumb,
  type DeereField,
  type DeereMachine,
  type DeereOrganization,
  type DeereTokenResponse,
} from '../../../connectors/deere/schemas';
import type { MachineKind } from '../../../domain/fleet';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG, type SimFarm } from '../../types';
import { currentClock } from '../clock';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { firstOfKind } from '../faults';
import { round, seededShuffle } from '../feed';
import {
  escapeHtml,
  formBody,
  header,
  html,
  json,
  redirect,
  type SimRequest,
  type SimResponse,
} from '../http';
import type { IssuedGrant } from '../state';
import { deereConnectionsRoutes } from './connections-routes';
import { deereFieldsRoutes } from './fields-routes';
import type { DeerePlatformRequest, DeereRouteModule } from './modules';
import { deereOpsRoutes } from './ops-routes';
import {
  apiError,
  collection,
  paging,
  platformBase,
  simDeereFields,
  simDeereOrgs,
} from './platform';

export { simDeereFields, simDeereOrgs } from './platform';

/** The 1f route modules, in dispatch order (./modules.ts). */
export const DEERE_ROUTE_MODULES: readonly DeereRouteModule[] = [
  deereConnectionsRoutes,
  deereFieldsRoutes,
  deereOpsRoutes,
];

const OAUTH = `/oauth2/${DEERE_AUTH_SERVER_ID}/v1`;
/** Query flag of the sim-only unattended consent (never sent to the real Deere). */
export const SIM_AUTO_CONSENT_PARAM = 'sim_auto_consent';

function oauthError(status: number, error: string, description: string): SimResponse {
  return json(
    status,
    { error, error_description: description },
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const plusSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000).toISOString();

// ---------------------------------------------------------------------------------------------
// Machines of the simulated farm (orgs: ./platform.ts simDeereOrgs)
// ---------------------------------------------------------------------------------------------

function deereMachines(farm: SimFarm) {
  return farm.machines.filter((m) => m.vendorIds.deere);
}

/**
 * Deere's equipment type name for a simulated machine (JDLink sits in the tractor that pulls a
 * grain cart or a planter). // doc-derived, confirm (Deere equipment type names)
 */
const DEERE_EQUIPMENT_TYPE: Record<MachineKind, string> = {
  combine: 'Combine',
  tractor: 'Tractor',
  sprayer: 'Sprayer',
  planter: 'Tractor',
  grain_cart: 'Tractor',
  semi: 'Truck',
  trailer: 'Trailer',
  drone: 'Other',
  pickup: 'Truck',
  service_truck: 'Truck',
  loader: 'Loader',
};

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

function authorizeParams(req: SimRequest): URLSearchParams {
  return req.method === 'POST' ? formBody(req.body) : req.url.searchParams;
}

function redirectWith(redirectUri: string, params: Record<string, string>): SimResponse {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return redirect(u.toString());
}

function consentPage(p: URLSearchParams, action: string): SimResponse {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k) ?? '')}">`)
    .join('\n      ');
  const scopes = (p.get('scope') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => `<li><code>${escapeHtml(s)}</code></li>`)
    .join('');
  return html(
    200,
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Deere (simulated)</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f6f2;color:#1b2a1b;margin:0;padding:16px}
  main{max-width:420px;margin:48px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px #0002}
  h1{font-size:22px;margin:0 0 8px;color:#367c2b} p{line-height:1.5}
  button{font-size:16px;padding:10px 18px;border-radius:8px;border:0;margin-right:8px;cursor:pointer}
  .allow{background:#367c2b;color:#fff} .deny{background:#e5e7eb}
</style></head>
<body><main>
  <h1>Sign in to Deere (simulated)</h1>
  <p>This is the local vendor stand-in, not John Deere. Signed in as <strong>sim operator</strong>.</p>
  <p><strong>${escapeHtml(p.get('client_id') ?? '')}</strong> asks for access to your organizations:</p>
  <ul>${scopes}</ul>
  <form method="post" action="${escapeHtml(action)}">
      ${hidden}
    <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
  </form>
</main></body></html>`,
  );
}

function authorize(req: SimRequest, ctx: VendorContext): SimResponse {
  const p = authorizeParams(req);
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const state = p.get('state') ?? '';
  if (clientId !== SIM_CREDENTIALS.deere.clientId) {
    return html(400, '<h1>Unknown client_id</h1>');
  }
  if (!URL.canParse(redirectUri) || !/^https?:$/.test(new URL(redirectUri).protocol)) {
    return html(400, '<h1>Invalid redirect_uri</h1>');
  }
  if (p.get('response_type') !== 'code') {
    return redirectWith(redirectUri, { error: 'unsupported_response_type', state });
  }
  const auto = req.method === 'GET' && p.get(SIM_AUTO_CONSENT_PARAM) === '1';
  if (req.method === 'GET' && !auto) return consentPage(p, req.url.pathname);
  const decision = auto ? 'allow' : p.get('decision');
  if (decision !== 'allow') return redirectWith(redirectUri, { error: 'access_denied', state });
  const code = ctx.newToken(16);
  const now = ctx.now();
  ctx.state.deere.codes[code] = {
    clientId,
    redirectUri,
    scope: p.get('scope') ?? '',
    issuedAt: now.toISOString(),
    expiresAt: plusSeconds(now, ctx.tuning.authCodeTtlSeconds),
  };
  ctx.persist();
  return redirectWith(redirectUri, { code, state });
}

/** Client credentials from HTTP Basic or the form body (RFC 6749 §2.3.1). */
function clientOf(req: SimRequest, form: URLSearchParams): { id: string; secret: string } {
  const h = header(req.headers, 'authorization');
  const m = h ? /^Basic\s+(\S+)$/i.exec(h) : null;
  if (m?.[1]) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      return {
        id: decodeURIComponent(decoded.slice(0, i)),
        secret: decodeURIComponent(decoded.slice(i + 1)),
      };
    }
  }
  return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' };
}

function issueTokens(ctx: VendorContext, clientId: string, scope: string): DeereTokenResponse {
  const now = ctx.now();
  const access = ctx.newToken(24);
  const refresh = ctx.newToken(32);
  const base: Omit<IssuedGrant, 'expiresAt'> = { clientId, scope, issuedAt: now.toISOString() };
  ctx.state.deere.accessTokens[access] = {
    ...base,
    expiresAt: plusSeconds(now, ctx.tuning.accessTokenTtlSeconds),
  };
  ctx.state.deere.refreshTokens[refresh] = {
    ...base,
    expiresAt: plusSeconds(now, ctx.tuning.refreshTokenTtlSeconds),
  };
  ctx.persist();
  return {
    token_type: 'Bearer',
    expires_in: ctx.tuning.accessTokenTtlSeconds,
    access_token: access,
    refresh_token: refresh,
    scope,
  };
}

function token(req: SimRequest, ctx: VendorContext): SimResponse {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');
  const form = formBody(req.body);
  const client = clientOf(req, form);
  if (
    !safeEqual(client.id, SIM_CREDENTIALS.deere.clientId) ||
    !safeEqual(client.secret, SIM_CREDENTIALS.deere.clientSecret)
  ) {
    return oauthError(401, 'invalid_client', 'client authentication failed');
  }
  const grant = form.get('grant_type');
  const now = ctx.now().getTime();
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const issued = ctx.state.deere.codes[code];
    if (issued) delete ctx.state.deere.codes[code]; // single use
    if (!issued || Date.parse(issued.expiresAt) <= now || issued.clientId !== client.id) {
      ctx.persist();
      return oauthError(400, 'invalid_grant', 'authorization code is invalid or expired');
    }
    if (issued.redirectUri !== (form.get('redirect_uri') ?? '')) {
      ctx.persist();
      return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization');
    }
    ctx.counters.tokenGrants.authorization_code++;
    return json(200, issueTokens(ctx, client.id, issued.scope), { 'cache-control': 'no-store' });
  }
  if (grant === 'refresh_token') {
    if (firstOfKind(ctx.faults, 'token_revoked')) {
      // Everything issued so far is gone, the presented token included (so grants minted by
      // re-consents while the fault is on don't pile up in state.json).
      delete ctx.state.deere.refreshTokens[form.get('refresh_token') ?? ''];
      revokeBefore(ctx, ctx.now());
      ctx.persist();
      return oauthError(400, 'invalid_grant', 'refresh token revoked: the user must sign in again');
    }
    const rt = form.get('refresh_token') ?? '';
    const issued = ctx.state.deere.refreshTokens[rt];
    if (!issued || Date.parse(issued.expiresAt) <= now || issued.clientId !== client.id) {
      return oauthError(400, 'invalid_grant', 'refresh token is invalid, expired or already used');
    }
    delete ctx.state.deere.refreshTokens[rt]; // rotation: the old one is now invalid
    ctx.counters.tokenGrants.refresh_token++;
    return json(200, issueTokens(ctx, client.id, issued.scope), { 'cache-control': 'no-store' });
  }
  return oauthError(400, 'unsupported_grant_type', `grant_type '${grant ?? ''}' is not supported`);
}

/**
 * token_revoked: every grant issued before the cut-off is gone for good. While the fault is on
 * the cut-off is "now", so at most the grant of the latest re-consent exists at any time.
 */
function revokeBefore(ctx: VendorContext, cutoff: Date): void {
  const keep = (g: IssuedGrant) => Date.parse(g.issuedAt) >= cutoff.getTime();
  const d = ctx.state.deere;
  let changed = false;
  for (const m of [d.accessTokens, d.refreshTokens]) {
    for (const [k, g] of Object.entries(m)) {
      if (!keep(g)) {
        delete m[k];
        changed = true;
      }
    }
  }
  if (changed) ctx.persist();
}

const UNAUTHORIZED = { 'www-authenticate': 'Bearer error="invalid_token"' };

/** Validate the bearer token of an API call; null when OK, else the 401 reply. */
function checkAccess(req: SimRequest, ctx: VendorContext): SimResponse | null {
  const h = header(req.headers, 'authorization');
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  const tok = m?.[1];
  if (!tok) return apiError(401, 'Missing bearer token', UNAUTHORIZED);
  if (firstOfKind(ctx.faults, 'token_revoked')) {
    revokeBefore(ctx, ctx.now());
    ctx.counters.faults.token_revoked = (ctx.counters.faults.token_revoked ?? 0) + 1;
    return apiError(401, 'Access revoked: the user must sign in again', UNAUTHORIZED);
  }
  const grant = ctx.state.deere.accessTokens[tok];
  const now = ctx.now().getTime();
  if (!grant || Date.parse(grant.expiresAt) <= now) {
    return apiError(401, 'Invalid or expired access token', UNAUTHORIZED);
  }
  const expired = firstOfKind(ctx.faults, 'token_expired');
  if (expired && Date.parse(grant.issuedAt) < ctx.ruleStart(expired).getTime()) {
    delete ctx.state.deere.accessTokens[tok];
    ctx.persist();
    ctx.counters.faults.token_expired = (ctx.counters.faults.token_expired ?? 0) + 1;
    return apiError(401, 'Access token expired', UNAUTHORIZED);
  }
  const accept = header(req.headers, 'accept');
  if (
    accept &&
    !accept.includes(DEERE_MEDIA_TYPE) &&
    !accept.includes('application/json') &&
    !accept.includes('*/*')
  ) {
    return apiError(406, `Not acceptable: use Accept: ${DEERE_MEDIA_TYPE}`);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Platform API
// ---------------------------------------------------------------------------------------------

function organizations(r: DeerePlatformRequest, mods: readonly DeereRouteModule[]): SimResponse {
  const { req, ctx, base } = r;
  const pg = paging(req.url, 10);
  if ('kind' in pg) return pg;
  const orgs: DeereOrganization[] = simDeereOrgs(ctx.world.farm).map((o) => ({
    '@type': 'Organization',
    id: o.id,
    name: o.name,
    type: 'customer',
    member: true,
    links: [
      { rel: 'machines', uri: `${base}/organizations/${encodeURIComponent(o.id)}/machines` },
      ...mods.flatMap((m) => m.orgLinks?.(o, r) ?? []),
    ],
  }));
  return json(200, collection(req.url, orgs, pg.offset, pg.limit));
}

function machines(req: SimRequest, ctx: VendorContext, orgId: string): SimResponse {
  if (!simDeereOrgs(ctx.world.farm).some((o) => o.id === orgId)) {
    return apiError(403, `No access to organization ${orgId}`);
  }
  const pg = paging(req.url, 10);
  if ('kind' in pg) return pg;
  const base = platformBase(req);
  const list: DeereMachine[] = deereMachines(ctx.world.farm)
    .filter((m) => (m.deereOrgId ?? SIM_DEERE_HOME_ORG) === orgId)
    .map((m) => ({
      '@type': 'Machine',
      id: m.vendorIds.deere as string,
      name: m.unitNo,
      modelYear: m.year,
      // 1f: what the equipment sync maps a machine's kind from (from the simulated machine).
      equipmentType: { '@type': 'EquipmentType', name: DEERE_EQUIPMENT_TYPE[m.kind] },
      equipmentMake: { '@type': 'EquipmentMake', name: m.make },
      equipmentModel: { '@type': 'EquipmentModel', name: m.model },
      links: [
        {
          rel: 'breadcrumbs',
          uri: `${base}/machines/${encodeURIComponent(m.vendorIds.deere as string)}/breadcrumbs`,
        },
      ],
    }));
  return json(200, collection(req.url, list, pg.offset, pg.limit));
}

/**
 * The org's demo fields, minimal (1f): enough for deere.ops and the backfill to list fields in
 * sim before the fields module (deere-data) lands; that module answers this path first once it
 * does. Ids and orgs from ./platform.ts simDeereFields (the seed's external refs).
 */
function fields(req: SimRequest, ctx: VendorContext, orgId: string): SimResponse {
  if (!simDeereOrgs(ctx.world.farm).some((o) => o.id === orgId)) {
    return apiError(403, `No access to organization ${orgId}`);
  }
  const pg = paging(req.url, 10);
  if ('kind' in pg) return pg;
  const base = platformBase(req);
  const list: DeereField[] = simDeereFields(ctx.world.farm)
    .filter((f) => f.orgId === orgId)
    .map((f) => {
      const self = `${base}/organizations/${encodeURIComponent(orgId)}/fields/${encodeURIComponent(f.deereFieldId)}`;
      return {
        '@type': 'Field',
        id: f.deereFieldId,
        name: f.field.name,
        archived: false,
        links: [
          { rel: 'self', uri: self },
          { rel: 'owningOrganization', uri: `${base}/organizations/${encodeURIComponent(orgId)}` },
          { rel: 'fieldOperation', uri: `${self}/fieldOperations` },
        ],
      };
    });
  return json(200, collection(req.url, list, pg.offset, pg.limit));
}

/**
 * Breadcrumb spacing in wall ms. Deere records breadcrumbs every few seconds of machine time;
 * at 1x that is `intervalMs` of wall time. A sped-up simulation keeps roughly that density in
 * sim time (down to one breadcrumb per wall second, on the same epoch-aligned grid), so a cart's
 * one-minute unload at 30x isn't skipped between two 10 s samples.
 */
export function breadcrumbStepMs(intervalMs: number, speed: number): number {
  if (!(speed > 1)) return intervalMs;
  return Math.max(1_000, Math.floor(intervalMs / speed / 1_000) * 1_000);
}

function breadcrumbs(req: SimRequest, ctx: VendorContext, deereId: string): SimResponse {
  const machine = deereMachines(ctx.world.farm).find((m) => m.vendorIds.deere === deereId);
  if (!machine) return apiError(404, `Machine ${deereId} not found`);
  const startRaw = req.url.searchParams.get('startDate');
  const endRaw = req.url.searchParams.get('endDate');
  const start = startRaw ? Date.parse(startRaw) : Number.NaN;
  if (Number.isNaN(start)) return apiError(400, 'startDate (ISO 8601) is required');
  const nowMs = ctx.now().getTime();
  const end = endRaw ? Date.parse(endRaw) : nowMs;
  if (Number.isNaN(end)) return apiError(400, 'endDate must be ISO 8601');
  const pg = paging(req.url, 100);
  if ('kind' in pg) return pg;

  const key = `deere:breadcrumbs:${deereId}`;
  if (firstOfKind(ctx.faults, 'duplicate_page')) {
    const prev = ctx.lastPages.get(key);
    if (prev) {
      ctx.counters.faults.duplicate_page = (ctx.counters.faults.duplicate_page ?? 0) + 1;
      return json(200, prev.body);
    }
  }

  const step = breadcrumbStepMs(
    ctx.tuning.breadcrumbIntervalMs,
    currentClock(ctx.state.clock).speed,
  );
  const from = Math.max(start, nowMs - ctx.tuning.deereMaxLookbackMs);
  const to = Math.min(end, nowMs);
  const crumbs: DeereBreadcrumb[] = [];
  for (let t = Math.floor(from / step) * step + step; t <= to; t += step) {
    const s = ctx.world.machineAt(machine.id, ctx.simAt(new Date(t)));
    if (s?.activity !== 'working') continue; // Deere records breadcrumbs only while working
    crumbs.push({
      '@type': 'Breadcrumb',
      point: { lat: round(s.lat, 6), lon: round(s.lng, 6) },
      eventTimestamp: new Date(t).toISOString(),
      // Deere's documented shapes (Machine Locations API; src/connectors/deere/schemas.ts).
      speed: {
        '@type': 'measurementAsDouble',
        valueAsDouble: round(Math.max(0, s.speedMph) * 1.609344, 1),
        unit: 'km1hr-1',
      },
      heading: { '@type': 'measurementAsInteger', valueAsInteger: Math.round(s.heading) % 360 },
      machineState: { '@type': 'Breadcrumb$MachineState', value: 'Working' },
    });
  }
  const body = collection(req.url, crumbs, pg.offset, pg.limit);
  if (firstOfKind(ctx.faults, 'out_of_order')) {
    ctx.counters.faults.out_of_order = (ctx.counters.faults.out_of_order ?? 0) + 1;
    body.values = seededShuffle(body.values, req.seq);
  }
  ctx.lastPages.set(key, { after: null, body });
  return json(200, body);
}

/** The core platform routes (OAuth aside); null when the path isn't one of them. */
function coreRoute(r: DeerePlatformRequest, mods: readonly DeereRouteModule[]): SimResponse | null {
  const { req, ctx, parts } = r;
  if (parts.length === 1 && parts[0] === 'organizations') return organizations(r, mods);
  if (parts.length === 3 && parts[0] === 'organizations' && parts[2] === 'machines') {
    return machines(req, ctx, parts[1] as string);
  }
  if (parts.length === 3 && parts[0] === 'organizations' && parts[2] === 'fields') {
    return fields(req, ctx, parts[1] as string);
  }
  if (parts.length === 3 && parts[0] === 'machines' && parts[2] === 'breadcrumbs') {
    return breadcrumbs(req, ctx, parts[1] as string);
  }
  return null;
}

async function platform(
  req: SimRequest,
  ctx: VendorContext,
  mods: readonly DeereRouteModule[],
): Promise<SimResponse> {
  if (req.method !== 'GET') return apiError(405, 'Method not allowed');
  const denied = checkAccess(req, ctx);
  if (denied) return denied;
  // ['platform', …] → the segments after it
  const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent).slice(1);
  const r: DeerePlatformRequest = { req, ctx, parts, base: platformBase(req) };
  for (const m of mods) {
    const hit = await m.route?.(r);
    if (hit) return hit;
  }
  return coreRoute(r, mods) ?? apiError(404, `Not found: ${req.path} (not simulated)`);
}

/** /_control/vendor/deere/<key>/... → that module's control(), with req.path after `/<key>`. */
async function control(
  req: SimRequest,
  ctx: VendorControlContext,
  mods: readonly DeereRouteModule[],
): Promise<SimResponse> {
  const [, key = '', ...rest] = req.path.split('/');
  const mod = mods.find((m) => m.key === key);
  const sub = { ...req, path: `/${rest.join('/')}` };
  const hit = mod?.control ? await mod.control(sub, ctx) : null;
  return hit ?? json(404, { error: `no Deere control at ${req.path}` });
}

/** The Deere stand-in with these route modules (tests pass their own; the server uses all). */
export function deereModuleWith(mods: readonly DeereRouteModule[]): VendorModule {
  return {
    vendor: 'deere',
    error: apiError,
    handle(req, ctx) {
      if (req.path === `${OAUTH}/authorize`) return authorize(req, ctx);
      if (req.path === `${OAUTH}/token`) return token(req, ctx);
      if (!req.path.startsWith('/platform/')) return apiError(404, `Not found: ${req.path}`);
      return platform(req, ctx, mods);
    },
    control: (req, ctx) => control(req, ctx, mods),
  };
}

export const deereModule: VendorModule = deereModuleWith(DEERE_ROUTE_MODULES);
