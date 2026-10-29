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
 *   GET      /platform/machines/{id}/breadcrumbs?startDate=&endDate=&pageOffset=&itemLimit=
 *                                                  positions only while WORKING (plan §5)
 *
 * Each org's data is served under that org id (contracts §9), so the org a sync reads from is
 * the external_refs source_org it looks up.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  DEERE_AUTH_SERVER_ID,
  DEERE_MEDIA_TYPE,
  type DeereBreadcrumb,
  type DeereLink,
  type DeereMachine,
  type DeereOrganization,
  type DeereTokenResponse,
} from '../../../connectors/deere/schemas';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG, type SimFarm } from '../../types';
import type { VendorContext, VendorModule } from '../context';
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

const OAUTH = `/oauth2/${DEERE_AUTH_SERVER_ID}/v1`;
/** Query flag of the sim-only unattended consent (never sent to the real Deere). */
export const SIM_AUTO_CONSENT_PARAM = 'sim_auto_consent';

function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { errors: [{ message, guid: `sim-${status}` }] }, headers);
}

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
// Orgs and machines of the simulated farm
// ---------------------------------------------------------------------------------------------

export function simDeereOrgs(farm: SimFarm): { id: string; name: string }[] {
  const names = new Map<string, string>();
  const add = (id: string | undefined, name: string) => {
    if (id && !names.has(id)) names.set(id, name);
  };
  for (const u of farm.farms) add(u.deereOrgId, u.name);
  for (const m of farm.machines) add(m.deereOrgId, `Simulated org ${m.deereOrgId}`);
  for (const f of farm.fields)
    add(f.sharedWith?.deereOrgId, `Simulated org ${f.sharedWith?.deereOrgId}`);
  add(SIM_DEERE_HOME_ORG, 'Home operation (simulated)');
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}

function deereMachines(farm: SimFarm) {
  return farm.machines.filter((m) => m.vendorIds.deere);
}

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
    const revoked = firstOfKind(ctx.faults, 'token_revoked');
    if (revoked) {
      revokeBefore(ctx, ctx.ruleStart(revoked));
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

/** token_revoked: every grant issued before the cut-off is gone for good. */
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
  const revoked = firstOfKind(ctx.faults, 'token_revoked');
  if (revoked) {
    revokeBefore(ctx, ctx.ruleStart(revoked));
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

function paging(url: URL, defaultLimit: number): { offset: number; limit: number } | SimResponse {
  const offset = Number(url.searchParams.get('pageOffset') ?? 0);
  const limit = Number(url.searchParams.get('itemLimit') ?? defaultLimit);
  if (!Number.isInteger(offset) || offset < 0) return apiError(400, 'pageOffset must be >= 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return apiError(400, 'itemLimit must be 1-100');
  }
  return { offset, limit };
}

function collection<T>(url: URL, all: T[], offset: number, limit: number) {
  const self = new URL(url);
  const links: DeereLink[] = [{ rel: 'self', uri: self.toString() }];
  if (offset + limit < all.length) {
    const next = new URL(url);
    next.searchParams.set('pageOffset', String(offset + limit));
    next.searchParams.set('itemLimit', String(limit));
    links.push({ rel: 'nextPage', uri: next.toString() });
  }
  return { links, total: all.length, values: all.slice(offset, offset + limit) };
}

function platformBase(req: SimRequest): string {
  return `${req.url.origin}/deere/platform`;
}

function organizations(req: SimRequest, ctx: VendorContext): SimResponse {
  const pg = paging(req.url, 10);
  if ('kind' in pg) return pg;
  const base = platformBase(req);
  const orgs: DeereOrganization[] = simDeereOrgs(ctx.world.farm).map((o) => ({
    '@type': 'Organization',
    id: o.id,
    name: o.name,
    type: 'customer',
    member: true,
    links: [{ rel: 'machines', uri: `${base}/organizations/${encodeURIComponent(o.id)}/machines` }],
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
      links: [
        {
          rel: 'breadcrumbs',
          uri: `${base}/machines/${encodeURIComponent(m.vendorIds.deere as string)}/breadcrumbs`,
        },
      ],
    }));
  return json(200, collection(req.url, list, pg.offset, pg.limit));
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

  const step = ctx.tuning.breadcrumbIntervalMs;
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
      speed: { value: round(Math.max(0, s.speedMph) * 1.609344, 1), unit: 'km/hr' },
      heading: { value: round(s.heading, 1), unit: 'deg' },
      machineState: 'Working',
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

export const deereModule: VendorModule = {
  vendor: 'deere',
  error: apiError,
  handle(req, ctx) {
    if (req.path === `${OAUTH}/authorize`) return authorize(req, ctx);
    if (req.path === `${OAUTH}/token`) return token(req, ctx);
    if (!req.path.startsWith('/platform/')) return apiError(404, `Not found: ${req.path}`);
    if (req.method !== 'GET') return apiError(405, 'Method not allowed');
    const denied = checkAccess(req, ctx);
    if (denied) return denied;
    const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent); // ['platform', …]
    if (parts.length === 2 && parts[1] === 'organizations') return organizations(req, ctx);
    if (parts.length === 4 && parts[1] === 'organizations' && parts[3] === 'machines') {
      return machines(req, ctx, parts[2] as string);
    }
    if (parts.length === 4 && parts[1] === 'machines' && parts[3] === 'breadcrumbs') {
      return breadcrumbs(req, ctx, parts[2] as string);
    }
    return apiError(404, `Not found: ${req.path} (not simulated)`);
  },
};
