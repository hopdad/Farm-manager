/**
 * CNH FieldOps stand-in (mounted at /cnh; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): CNH's own paths and shapes from its published OpenAPI
 * (SwaggerHub CNH/FieldOps-API 1.0.0, read Oct 30, 2026) for the demo's Case IH machines
 * (`simTelematicsMachines(farm, 'cnh')`: C3, T1, by VIN, in company SIM_CNH_COMPANY_ID):
 *
 *   /cnh/identity/authorize, /oauth/token, /oauth/revoke   Auth0: response_type, scope
 *       (offline_access), state, client_id, redirect_uri, audience and connection all required
 *       (SIM_CNH_AUTH); client_secret_post; the refresh grant sends redirect_uri too
 *   /cnh/v1/companies, /UserProfile, /companies/{id}/overview, …/boundaries (JSON)
 *   /cnh/v1/equipment, /equipment/{vin} (JSON; no paging), /equipment/{vin}/metrics (cursor)
 *   /cnh/v1/Fleet/{page}, /Fleet/Equipment/{vin}, /Fleet/Equipment/{vin}/{Series}/{startUTC}/
 *       {endUTC}/{page} (XML in the ISO 15143-3 namespace, lower-case location keys; Locations,
 *       CumulativeOperatingHours, Distance, FuelRemainingRatio, DEFRemaining, EngineCondition,
 *       CautionCodes, Faults)
 * Every API call needs `Authorization: Bearer` AND `Ocp-Apim-Subscription-Key`; the states a
 * real connection meets, with knobs under /_control/vendor/cnh/… (./control-types.ts): a VIN
 * without an accepted EULA (403 "EULA not accepted for the VIN. Login to FieldOps to accept
 * EULA."; vehicle info still answers), a wrong key or environment (APIM's 401 with
 * `WWW-Authenticate: AzureApiManagementKey`), an expired token (401), 429 with an integer
 * Retry-After (the stand-in's generic rate_limit fault). Error bodies: APIM `{ statusCode,
 * message }`; the API's `{ message, statusCode, requestId, errorMessages }`; OAuth errors
 * `{ error, error_description }`.
 *
 * Telemetry is sampled from the world and stamped with wall time (contracts §9): the Locations
 * series every 5 s (the trail), the snapshot and the counter series on a 15-min grid (CNH: "a
 * delay of up to one hour"). Grants and knobs live in `state.vendors.cnh` (a reset clears them).
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { CNH_EULA_MESSAGE } from '../../../connectors/cnh/schemas';
import { deterministicId } from '../../../domain/ids';
import { hash32 } from '../../rng';
import {
  SIM_CNH_AUTH,
  SIM_CNH_COMPANY_ID,
  SIM_CREDENTIALS,
  type SimMachine,
  simTelematicsMachines,
} from '../../types';
import { el, isoLinks, isoXmlDocument, type XmlNode } from '../aemp/iso-xml';
import { simDefPct } from '../aemp/routes';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { firstIssue } from '../control';
import {
  bearerToken,
  escapeHtml,
  formBody,
  header,
  html,
  json,
  redirect,
  type SimRequest,
  type SimResponse,
} from '../http';
import {
  type CnhSimCaution,
  type CnhSimFault,
  type CnhSimSettings,
  cnhSimCodesRequestSchema,
  cnhSimSettingsRequestSchema,
} from './control-types';

/** The stand-in's own query flag for unattended consent (sim only; `cnhSimAutoConnect`). */
export const CNH_SIM_AUTO_CONSENT = 'sim_auto_consent';
/** Locations series grid (wall ms) and the snapshot / counters grid. */
export const CNH_SIM_LOCATION_GRID_MS = 5_000;
export const CNH_SIM_SNAPSHOT_GRID_MS = 15 * 60_000;
/** Items per series or snapshot page ("Default page size is 100"). */
export const CNH_SIM_PAGE_SIZE = 100;
const MAX_WINDOW_MS = 7 * 86_400_000;
const MAX_CODES = 200;
const API_HOST = 'https://api-data.cnh.com/v1';
const COMPANY_NAME = 'Demo farm (simulated)';

// ---- state ----------------------------------------------------------------------------------

interface Grant {
  clientId: string;
  issuedAt: string;
  expiresAt: string;
  redirectUri?: string;
}

interface CnhBag {
  codes: Record<string, Grant>;
  access: Record<string, Grant>;
  refresh: Record<string, Grant>;
  settings: CnhSimSettings;
  cautions: CnhSimCaution[];
  faults: CnhSimFault[];
}

function bag(ctx: { state: VendorContext['state'] }): CnhBag {
  ctx.state.vendors ??= {};
  ctx.state.vendors.cnh ??= {};
  const b = ctx.state.vendors.cnh as Partial<CnhBag>;
  b.codes ??= {};
  b.access ??= {};
  b.refresh ??= {};
  b.settings ??= { eulaMissing: [], locationsEmpty: [], wrongKey: false };
  b.cautions ??= [];
  b.faults ??= [];
  return b as CnhBag;
}

const plus = (now: Date, s: number) => new Date(now.getTime() + s * 1000).toISOString();

function prune(grants: Record<string, Grant>, now: number): void {
  for (const [k, g] of Object.entries(grants)) if (Date.parse(g.expiresAt) <= now) delete grants[k];
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---- replies ----------------------------------------------------------------------------------

/** APIM-style `{ statusCode, message }` (the generic faults use it too). */
function cnhError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { statusCode: status, message }, headers);
}

/** The API's own error body (400/403/404/500 in the spec). */
function apiError(status: number, message: string, errorMessages: string[] = []) {
  return json(status, {
    message,
    statusCode: status,
    requestId: randomUUID(),
    errorMessages: errorMessages.length ? errorMessages : [message],
  });
}

function oauthError(status: number, error: string, description: string) {
  return json(status, { error, error_description: description }, { 'cache-control': 'no-store' });
}

function xml(body: string): SimResponse {
  return {
    kind: 'reply',
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body,
  };
}

// ---- identity (Auth0) -------------------------------------------------------------------------

/** The seven /authorize parameters CNH's spec marks required. */
const AUTHORIZE_PARAMS = [
  'response_type',
  'scope',
  'state',
  'client_id',
  'redirect_uri',
  'audience',
  'connection',
] as const;

function consentPage(p: URLSearchParams, action: string): SimResponse {
  const hidden = AUTHORIZE_PARAMS.map(
    (k) => `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k) ?? '')}">`,
  ).join('\n      ');
  return html(
    200,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to FieldOps (simulated)</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f3f3;color:#222;margin:0;padding:16px}
main{max-width:420px;margin:48px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px #0002}
h1{font-size:22px;margin:0 0 8px;color:#9b1b1e} button{font-size:16px;padding:10px 18px;border-radius:8px;border:0;margin-right:8px}
.allow{background:#9b1b1e;color:#fff} .deny{background:#e5e7eb}</style></head>
<body><main>
  <h1>Sign in to FieldOps (simulated)</h1>
  <p>This is the local vendor stand-in, not CNH. Signed in as <strong>sim farm manager</strong> of ${escapeHtml(COMPANY_NAME)}.</p>
  <p><strong>${escapeHtml(p.get('client_id') ?? '')}</strong> asks for offline access to your FieldOps data.</p>
  <form method="post" action="${escapeHtml(action)}">
      ${hidden}
    <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
  </form>
</main></body></html>`,
  );
}

function redirectWith(uri: string, params: Record<string, string>): SimResponse {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return redirect(u.toString());
}

function authorize(req: SimRequest, ctx: VendorContext): SimResponse {
  const p = req.method === 'POST' ? formBody(req.body) : req.url.searchParams;
  const missing = AUTHORIZE_PARAMS.filter((k) => !p.get(k));
  if (missing.length) {
    return html(
      400,
      `<h1>Bad request</h1><p>Missing required parameter: ${escapeHtml(missing.join(', '))}</p>`,
    );
  }
  if (p.get('client_id') !== SIM_CREDENTIALS.cnh.clientId)
    return html(400, '<h1>Unknown client</h1>');
  const redirectUri = p.get('redirect_uri') as string;
  if (!URL.canParse(redirectUri) || !/^https?:$/.test(new URL(redirectUri).protocol)) {
    return html(400, '<h1>Invalid redirect_uri</h1>');
  }
  if (p.get('audience') !== SIM_CNH_AUTH.audience) {
    return html(403, `<h1>Service not found: ${escapeHtml(p.get('audience') ?? '')}</h1>`);
  }
  if (p.get('connection') !== SIM_CNH_AUTH.connection) {
    return html(400, `<h1>Unknown connection: ${escapeHtml(p.get('connection') ?? '')}</h1>`);
  }
  const state = p.get('state') as string;
  if (p.get('response_type') !== 'code') {
    return redirectWith(redirectUri, { error: 'unsupported_response_type', state });
  }
  if (!(p.get('scope') ?? '').split(/\s+/).includes('offline_access')) {
    return redirectWith(redirectUri, { error: 'invalid_scope', state });
  }
  const auto = req.method === 'GET' && p.get(CNH_SIM_AUTO_CONSENT) === '1';
  if (req.method === 'GET' && !auto) return consentPage(p, req.url.pathname);
  if ((auto ? 'allow' : p.get('decision')) !== 'allow') {
    return redirectWith(redirectUri, { error: 'access_denied', state });
  }
  const b = bag(ctx);
  const code = ctx.newToken(16);
  const now = ctx.now();
  b.codes[code] = {
    clientId: SIM_CREDENTIALS.cnh.clientId,
    redirectUri,
    issuedAt: now.toISOString(),
    expiresAt: plus(now, ctx.tuning.authCodeTtlSeconds),
  };
  ctx.persist();
  return redirectWith(redirectUri, { code, state });
}

function issue(ctx: VendorContext): Record<string, unknown> {
  const b = bag(ctx);
  const now = ctx.now();
  prune(b.access, now.getTime());
  prune(b.refresh, now.getTime());
  const access = ctx.newToken(24);
  const refresh = ctx.newToken(32);
  const base = { clientId: SIM_CREDENTIALS.cnh.clientId, issuedAt: now.toISOString() };
  b.access[access] = { ...base, expiresAt: plus(now, ctx.tuning.accessTokenTtlSeconds) };
  b.refresh[refresh] = { ...base, expiresAt: plus(now, ctx.tuning.refreshTokenTtlSeconds) };
  ctx.persist();
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: ctx.tuning.accessTokenTtlSeconds,
    token_type: 'Bearer',
    scope: 'offline_access',
  };
}

function token(req: SimRequest, ctx: VendorContext): SimResponse {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');
  const form = formBody(req.body);
  // client_secret_post: CNH's spec documents the client's credentials in the form body.
  if (
    !safeEqual(form.get('client_id') ?? '', SIM_CREDENTIALS.cnh.clientId) ||
    !safeEqual(form.get('client_secret') ?? '', SIM_CREDENTIALS.cnh.clientSecret)
  ) {
    return oauthError(
      401,
      'invalid_client',
      'client authentication failed (send client_id and client_secret in the form body)',
    );
  }
  const b = bag(ctx);
  const now = ctx.now().getTime();
  const grant = form.get('grant_type');
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const issued = b.codes[code];
    if (issued) delete b.codes[code]; // single use
    ctx.persist();
    if (!issued || Date.parse(issued.expiresAt) <= now) {
      return oauthError(403, 'invalid_grant', 'Invalid authorization code');
    }
    if (issued.redirectUri !== form.get('redirect_uri')) {
      return oauthError(403, 'invalid_grant', 'redirect_uri does not match the authorization');
    }
    ctx.counters.tokenGrants.authorization_code++;
    return json(200, issue(ctx), { 'cache-control': 'no-store' });
  }
  if (grant === 'refresh_token') {
    if (!form.get('redirect_uri')) {
      return oauthError(400, 'invalid_request', 'Missing required parameter: redirect_uri');
    }
    const rt = form.get('refresh_token') ?? '';
    const issued = b.refresh[rt];
    if (!issued || Date.parse(issued.expiresAt) <= now) {
      return oauthError(403, 'invalid_grant', 'Unknown or invalid refresh token.');
    }
    delete b.refresh[rt]; // rotation (unconfirmed for CNH's tenant: the stricter case)
    ctx.counters.tokenGrants.refresh_token++;
    return json(200, issue(ctx), { 'cache-control': 'no-store' });
  }
  return oauthError(400, 'unsupported_grant_type', `grant_type '${grant ?? ''}' is not supported`);
}

function revoke(req: SimRequest, ctx: VendorContext): SimResponse {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');
  let body: { client_id?: string; client_secret?: string; token?: string };
  try {
    body = JSON.parse(req.body || '{}');
  } catch {
    return oauthError(400, 'invalid_request', 'the body must be JSON');
  }
  if (
    body.client_id !== SIM_CREDENTIALS.cnh.clientId ||
    body.client_secret !== SIM_CREDENTIALS.cnh.clientSecret
  ) {
    return oauthError(401, 'invalid_client', 'client authentication failed');
  }
  const b = bag(ctx);
  delete b.refresh[body.token ?? ''];
  ctx.persist();
  return json(200, {});
}

// ---- API authentication (APIM first, then the token) -------------------------------------------

const APIM_HEADER = {
  'www-authenticate':
    'AzureApiManagementKey realm="https://api-data.cnh.com/",name="Ocp-Apim-Subscription-Key",type="header"',
};

function checkAccess(req: SimRequest, ctx: VendorContext): SimResponse | null {
  const key = header(req.headers, 'ocp-apim-subscription-key');
  if (!key) {
    return cnhError(
      401,
      'Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API.',
      APIM_HEADER,
    );
  }
  const b = bag(ctx);
  if (b.settings.wrongKey || !safeEqual(key, SIM_CREDENTIALS.cnh.subscriptionKey)) {
    return cnhError(
      401,
      'Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.',
      APIM_HEADER,
    );
  }
  const tok = bearerToken(req.headers);
  const grant = tok ? b.access[tok] : undefined;
  if (!grant || Date.parse(grant.expiresAt) <= ctx.now().getTime()) {
    return cnhError(401, 'Unauthorized. Access token is missing or invalid.', {
      'www-authenticate': 'Bearer error="invalid_token"',
    });
  }
  return null;
}

// ---- data -------------------------------------------------------------------------------------

function machines(world: VendorContext['world']): SimMachine[] {
  return simTelematicsMachines(world.farm, 'cnh');
}

const vinOf = (m: SimMachine) => m.telematics?.id ?? '';
/** The machine's modem (PCM) serial, as CNH puts it in SerialNumber (the modem IMEI). */
const modemSerial = (m: SimMachine) =>
  String(356_938_000_000_000 + (hash32('sim-cnh-modem', m.id) % 1_000_000));

/** Unit numbers or VINs → VINs (the knobs take either). */
function vinsFrom(world: VendorContext['world'], list: readonly string[]): string[] {
  return list.flatMap((x) => {
    const m = machines(world).find((y) => y.unitNo === x || vinOf(y) === x);
    return m ? [vinOf(m)] : [];
  });
}

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();

function sampleAt(ctx: VendorContext, m: SimMachine, wall: number) {
  return ctx.world.machineAt(m.id, ctx.simAt(new Date(wall)));
}

function equipmentItem(m: SimMachine, detail = false): Record<string, unknown> {
  return {
    vin: vinOf(m),
    nickName: m.unitNo,
    companyName: COMPANY_NAME,
    companyId: m.telematics?.provider ?? SIM_CNH_COMPANY_ID,
    brand: 'CSAG',
    model: m.model,
    productLine: m.kind === 'combine' ? 'COMBINES' : 'TRACTORS',
    productType: 'AGRICULTURAL',
    devices: [
      {
        model: 'PCM',
        serialNumber: modemSerial(m),
        ...(detail
          ? {
              type: 'modem',
              subscription: [
                {
                  name: 'AFS Connect',
                  validFrom: '2024-01-01T00:00:00Z',
                  expirationDate: '2029-01-01T00:00:00Z',
                },
              ],
            }
          : {}),
      },
      {
        model: 'AFS Pro 1200',
        serialNumber: `D-${m.unitNo}`,
        fileType: 'ISOXML',
        ...(detail ? { type: 'display' } : {}),
      },
    ],
    ...(detail ? { fileTransferEnabled: true } : {}),
  };
}

/** The demo farm's fields as CNH sees them: one grower, one farm, the first two fields. */
function cnhFields(world: VendorContext['world']) {
  return world.farm.fields.slice(0, 2).map((f) => ({
    field: f,
    id: deterministicId('sim-cnh', `field:${f.key}`),
    boundaryId: deterministicId('sim-cnh', `boundary:${f.key}`),
  }));
}
const GROWER_ID = deterministicId('sim-cnh', 'grower');
const FARM_ID = deterministicId('sim-cnh', 'farm');

/** One machine's snapshot `Equipment` element (CNH's lower-case location keys). */
function snapshotEquipment(ctx: VendorContext, m: SimMachine, wall: number): XmlNode {
  const s = sampleAt(ctx, m, wall);
  const datetime = iso(wall);
  const children: XmlNode[] = [
    el('EquipmentHeader', [
      el('OEMName', 'CASE IH'),
      el('Model', m.model),
      el('EquipmentID', m.unitNo),
      el('SerialNumber', modemSerial(m)),
      el('VIN', vinOf(m)),
    ]),
  ];
  if (s) {
    children.push(
      el(
        'Location',
        [
          el('latitude', r6(s.lat)),
          el('longitude', r6(s.lng)),
          el('altitude', 245),
          el('altitudeUnits', 'metre'),
        ],
        { datetime },
      ),
      el('CumulativeOperatingHours', [el('Hour', r1(s.engineHours))], { datetime }),
      el(
        'Distance',
        [el('Odometer', r1(s.odometerMi * 1.609344)), el('OdometerUnits', 'kilometre')],
        {
          datetime,
        },
      ),
      el('FuelRemaining', [el('Percent', Math.round(s.fuelPct))], { datetime }),
      el('DEFRemaining', [el('Percent', simDefPct(m.id))], { datetime }),
      el('EngineStatus', [el('EngineNumber', `FPT-${m.unitNo}`), el('Running', s.engineOn)], {
        datetime,
      }),
    );
  }
  return el('Equipment', children);
}

function links(self: string, page: number, more: boolean): XmlNode[] {
  const base = self.replace(/\/\d+(\?.*)?$/, '');
  return isoLinks([
    { rel: 'self', href: `${base}/${page}` },
    ...(page > 1 ? [{ rel: 'prev', href: `${base}/${page - 1}` }] : []),
    ...(more ? [{ rel: 'next', href: `${base}/${page + 1}` }] : []),
  ]);
}

function fleetDoc(
  ctx: VendorContext,
  list: SimMachine[],
  page: number,
  selfPath: string,
): SimResponse {
  const wall = floorTo(ctx.now().getTime(), CNH_SIM_SNAPSHOT_GRID_MS);
  const slice = list.slice((page - 1) * CNH_SIM_PAGE_SIZE, page * CNH_SIM_PAGE_SIZE);
  const more = list.length > page * CNH_SIM_PAGE_SIZE;
  return xml(
    isoXmlDocument(
      el(
        'Fleet',
        [
          ...links(`${API_HOST}${selfPath}`, page, more),
          ...slice.map((m) => snapshotEquipment(ctx, m, wall)),
        ],
        { version: 'iso15143-3', snapshotTime: ctx.now().toISOString() },
      ),
    ),
  );
}

/** A series' items: a builder per series name (root element, item element, the item's children). */
const COUNTER_SERIES: Record<
  string,
  {
    root: string;
    item: string;
    children: (s: NonNullable<ReturnType<typeof sampleAt>>, m: SimMachine) => XmlNode[];
  }
> = {
  CumulativeOperatingHours: {
    root: 'CumulativeOperatingHoursMessages',
    item: 'CumulativeOperatingHours',
    children: (s) => [el('Hour', r1(s.engineHours))],
  },
  Distance: {
    root: 'DistanceMessages',
    item: 'Distance',
    children: (s) => [
      el('Odometer', r1(s.odometerMi * 1.609344)),
      el('OdometerUnits', 'kilometre'),
    ],
  },
  FuelRemainingRatio: {
    root: 'FuelRemainingMessages',
    item: 'FuelRemaining',
    children: (s) => [el('Percent', Math.round(s.fuelPct))],
  },
  DEFRemaining: {
    root: 'DEFRemainingMessages',
    item: 'DEFRemaining',
    children: (_s, m) => [el('Percent', simDefPct(m.id))],
  },
  EngineCondition: {
    root: 'EngineStatusMessages',
    item: 'EngineStatus',
    children: (s, m) => [el('EngineNumber', `FPT-${m.unitNo}`), el('Running', s.engineOn)],
  },
};

function seriesDoc(
  ctx: VendorContext,
  m: SimMachine,
  name: string,
  from: number,
  to: number,
  page: number,
  selfPath: string,
): SimResponse | null {
  const b = bag(ctx);
  const vin = vinOf(m);
  let root: string;
  let items: XmlNode[];
  if (name === 'Locations') {
    root = 'LocationMessages';
    const empty = vinsFrom(ctx.world, b.settings.locationsEmpty).includes(vin);
    const first =
      floorTo(from, CNH_SIM_LOCATION_GRID_MS) +
      (from % CNH_SIM_LOCATION_GRID_MS ? CNH_SIM_LOCATION_GRID_MS : 0);
    const end = Math.min(to, ctx.now().getTime());
    items = [];
    for (let t = first; !empty && t <= end; t += CNH_SIM_LOCATION_GRID_MS) {
      const s = sampleAt(ctx, m, t);
      if (s) {
        items.push(
          el('Location', [el('latitude', r6(s.lat)), el('longitude', r6(s.lng))], {
            datetime: iso(t),
          }),
        );
      }
    }
  } else if (name === 'CautionCodes') {
    root = 'CautionMessages';
    items = b.cautions
      .filter(
        (c) => c.vin === vin && Date.parse(c.datetime) >= from && Date.parse(c.datetime) <= to,
      )
      .map((c) =>
        el(
          'CautionDescriptions',
          [
            el('Identifier', c.Identifier),
            ...(c.Description ? [el('Description', c.Description)] : []),
            ...(c.Severity ? [el('Severity', c.Severity)] : []),
            el('Active', c.Active),
          ],
          { datetime: c.datetime },
        ),
      );
  } else if (name === 'Faults') {
    root = 'DiagnosticTroubleCode';
    items = b.faults
      .filter(
        (f) => f.vin === vin && Date.parse(f.datetime) >= from && Date.parse(f.datetime) <= to,
      )
      .map((f) =>
        el(
          'FaultCode',
          [
            el('CodeIdentifier', f.CodeIdentifier),
            ...(f.CodeDescription ? [el('CodeDescription', f.CodeDescription)] : []),
            ...(f.CodeSeverity ? [el('CodeSeverity', f.CodeSeverity)] : []),
          ],
          { datetime: f.datetime },
        ),
      );
  } else {
    const spec = COUNTER_SERIES[name];
    if (!spec) return null;
    root = spec.root;
    items = [];
    const end = Math.min(to, ctx.now().getTime());
    for (
      let t = floorTo(end, CNH_SIM_SNAPSHOT_GRID_MS);
      t >= from && items.length < 4 * 24;
      t -= CNH_SIM_SNAPSHOT_GRID_MS
    ) {
      const s = sampleAt(ctx, m, t);
      if (s) items.unshift(el(spec.item, spec.children(s, m), { datetime: iso(t) }));
    }
  }
  const slice = items.slice((page - 1) * CNH_SIM_PAGE_SIZE, page * CNH_SIM_PAGE_SIZE);
  const more = items.length > page * CNH_SIM_PAGE_SIZE;
  return xml(isoXmlDocument(el(root, [...links(`${API_HOST}${selfPath}`, page, more), ...slice])));
}

function metrics(req: SimRequest, ctx: VendorContext, m: SimMachine): SimResponse {
  const from = Date.parse(req.url.searchParams.get('startDate') ?? '');
  const to = Date.parse(req.url.searchParams.get('endDate') ?? '');
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
    return apiError(400, 'startDate and endDate are required ISO 8601 date-times');
  }
  const limit = Math.min(500, Math.max(1, Number(req.url.searchParams.get('limit') ?? 100) || 100));
  const offset =
    Number(Buffer.from(req.url.searchParams.get('cursor') ?? '', 'base64url').toString() || 0) || 0;
  const all: number[] = [];
  const end = Math.min(to, ctx.now().getTime());
  for (let t = floorTo(from, 60_000) + (from % 60_000 ? 60_000 : 0); t <= end; t += 60_000)
    all.push(t);
  const page = all.slice(offset, offset + limit);
  const items = page.flatMap((t) => {
    const s = sampleAt(ctx, m, t);
    if (!s) return [];
    return [
      {
        systemDatetime: iso(t),
        position: {
          time: iso(t),
          latitude: r6(s.lat),
          longitude: r6(s.lng),
          fieldIds: [],
          errorTags: [],
        },
        telemetry: [
          {
            metric: 'ENG_HOURS',
            function: 'last',
            value: String(r1(s.engineHours)),
            type: 'numeric',
            unitOfMeasure: 'h',
          },
          {
            metric: 'FUEL_LEVEL',
            function: 'last',
            value: Math.round(s.fuelPct),
            type: 'numeric',
            unitOfMeasure: '%',
          },
          {
            metric: 'DEF_LEVEL',
            function: 'last',
            value: simDefPct(m.id),
            type: 'numeric',
            unitOfMeasure: '%',
          },
        ],
      },
    ];
  });
  const self = new URL(`${API_HOST}${req.path}`);
  for (const [k, v] of req.url.searchParams) self.searchParams.set(k, v);
  const out: { rel: string; href: string }[] = [{ rel: 'self', href: self.toString() }];
  if (offset + limit < all.length) {
    const next = new URL(self);
    next.searchParams.set('cursor', Buffer.from(String(offset + limit)).toString('base64url'));
    out.push({ rel: 'next', href: next.toString() });
  }
  return json(200, { links: out, items });
}

function eula(): SimResponse {
  return apiError(403, CNH_EULA_MESSAGE, [CNH_EULA_MESSAGE]);
}

function api(req: SimRequest, ctx: VendorContext): SimResponse {
  const denied = checkAccess(req, ctx);
  if (denied) return denied;
  if (req.method !== 'GET') return apiError(405, 'Method not allowed');
  const path = req.path.slice('/v1'.length) || '/';
  const all = machines(ctx.world);
  const noEula = new Set(vinsFrom(ctx.world, bag(ctx).settings.eulaMissing));
  const byVin = (vin: string) => all.find((m) => vinOf(m) === decodeURIComponent(vin));

  if (path === '/companies') {
    return json(200, { companies: [{ id: SIM_CNH_COMPANY_ID, name: COMPANY_NAME }] });
  }
  if (path === '/UserProfile') {
    return json(200, {
      companyId: SIM_CNH_COMPANY_ID,
      companyName: COMPANY_NAME,
      userName: 'sim.farm.manager',
    });
  }
  const company = /^\/companies\/([^/]+)(\/.*)$/.exec(path);
  if (company) {
    if (decodeURIComponent(company[1] ?? '') !== SIM_CNH_COMPANY_ID) {
      return apiError(403, 'Forbidden', ['You do not have permission to access this resource.']);
    }
    const rest = company[2] ?? '';
    const fields = cnhFields(ctx.world);
    if (rest === '/overview') {
      return json(200, {
        companyId: SIM_CNH_COMPANY_ID,
        companyName: COMPANY_NAME,
        growers: [
          {
            id: GROWER_ID,
            name: COMPANY_NAME,
            farms: [
              {
                id: FARM_ID,
                name: 'Home farm',
                fields: fields.map((f) => ({ id: f.id, name: f.field.name })),
              },
            ],
          },
        ],
      });
    }
    const fb = /^\/fields\/([^/]+)\/boundaries$/.exec(rest);
    if (fb) {
      const f = fields.find((x) => x.id === fb[1]);
      if (!f) return apiError(404, 'Field not found');
      return json(200, {
        companyId: SIM_CNH_COMPANY_ID,
        growerId: GROWER_ID,
        farmId: FARM_ID,
        fieldId: f.id,
        boundaries: [
          {
            id: f.boundaryId,
            boundaryType: 'OUTER',
            area: Math.round(f.field.acres * 4046.8564),
            createdDate: '2024-03-01T00:00:00Z',
            modifiedDate: '2024-03-01T00:00:00Z',
          },
        ],
        irrigated: false,
        ownershipType: 'Owned',
      });
    }
    const bd = /^\/boundaries\/([^/]+)$/.exec(rest);
    if (bd) {
      const f = fields.find((x) => x.boundaryId === bd[1]);
      if (!f) return apiError(404, 'Boundary not found');
      const ring = f.field.boundary.coordinates[0]?.[0] ?? [];
      const xs = ring.map((p) => p[0] as number);
      const ys = ring.map((p) => p[1] as number);
      return json(200, {
        companyId: SIM_CNH_COMPANY_ID,
        growerId: GROWER_ID,
        farmId: FARM_ID,
        fieldId: f.id,
        boundaryId: f.boundaryId,
        passible: null,
        area: Math.round(f.field.acres * 4046.8564),
        boundaryType: 'OUTER',
        createdDate: '2024-03-01T00:00:00Z',
        modifiedDate: '2024-03-01T00:00:00Z',
        type: 'Polygon',
        coordinates: f.field.boundary.coordinates[0],
        boundingBox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        irrigated: false,
        ownershipType: 'Owned',
      });
    }
    return apiError(404, `Not found: ${req.path} (not simulated)`);
  }
  if (path === '/equipment') return json(200, { equipment: all.map((m) => equipmentItem(m)) });
  const eq = /^\/equipment\/([^/]+)(\/metrics)?$/.exec(path);
  if (eq) {
    const m = byVin(eq[1] ?? '');
    if (!m) return apiError(404, 'Equipment not found');
    if (!eq[2]) return json(200, equipmentItem(m, true));
    return noEula.has(vinOf(m)) ? eula() : metrics(req, ctx, m);
  }
  const fleet = /^\/Fleet\/(\d+)$/.exec(path);
  if (fleet) {
    const page = Number(fleet[1]);
    if (page < 1) return apiError(400, 'pageNumber starts at 1');
    // doc-derived, confirm: machines without an accepted EULA are left out of the page.
    return fleetDoc(
      ctx,
      all.filter((m) => !noEula.has(vinOf(m))),
      page,
      path,
    );
  }
  const one = /^\/Fleet\/Equipment\/([^/]+)$/.exec(path);
  if (one) {
    const m = byVin(one[1] ?? '');
    if (!m) return apiError(404, 'Equipment not found');
    return noEula.has(vinOf(m)) ? eula() : fleetDoc(ctx, [m], 1, path);
  }
  const series = /^\/Fleet\/Equipment\/([^/]+)\/([A-Za-z]+)\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
  if (series) {
    const m = byVin(series[1] ?? '');
    if (!m) return apiError(404, 'Equipment not found');
    if (noEula.has(vinOf(m))) return eula();
    const from = Date.parse(decodeURIComponent(series[3] ?? ''));
    const to = Date.parse(decodeURIComponent(series[4] ?? ''));
    if (Number.isNaN(from) || Number.isNaN(to) || from > to || to - from > MAX_WINDOW_MS) {
      return apiError(
        400,
        'startDateUTC and endDateUTC must be ISO 8601 date-times, at most 7 days apart',
      );
    }
    const reply = seriesDoc(ctx, m, series[2] ?? '', from, to, Number(series[5]), path);
    if (reply) return reply;
  }
  return apiError(404, `Not found: ${req.path} (not simulated)`);
}

// ---- knobs ------------------------------------------------------------------------------------

function parse<T>(req: SimRequest, schema: z.ZodType<T>): T | SimResponse {
  let body: unknown;
  try {
    body = req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const r = schema.safeParse(body);
  return r.success ? r.data : json(400, { error: firstIssue(r.error) });
}

function control(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const b = bag(ctx);
  if (req.path === '/settings') {
    if (req.method === 'GET') return json(200, b.settings);
    if (req.method !== 'POST') return json(405, { error: 'GET or POST' });
    const r = parse(req, cnhSimSettingsRequestSchema);
    if ('kind' in r) return r;
    if (r.eulaMissing) b.settings.eulaMissing = vinsFrom(ctx.world, r.eulaMissing);
    if (r.locationsEmpty) b.settings.locationsEmpty = vinsFrom(ctx.world, r.locationsEmpty);
    if (r.wrongKey !== undefined) b.settings.wrongKey = r.wrongKey;
    ctx.persist();
    ctx.log(`cnh settings: ${JSON.stringify(b.settings)}`);
    return json(200, b.settings);
  }
  if (req.path === '/codes') {
    if (req.method === 'GET') return json(200, { cautions: b.cautions, faults: b.faults });
    if (req.method !== 'POST') return json(405, { error: 'GET or POST' });
    const r = parse(req, cnhSimCodesRequestSchema);
    if ('kind' in r) return r;
    if (r.action === 'clear') {
      b.cautions = [];
      b.faults = [];
    } else {
      const [vin] = vinsFrom(ctx.world, [r.machine]);
      if (!vin) return json(404, { error: `no CNH machine '${r.machine}'` });
      const datetime = ctx.now().toISOString();
      if (r.action === 'caution') {
        b.cautions = [
          ...b.cautions,
          {
            vin,
            datetime,
            Identifier: r.code,
            Active: r.active,
            ...(r.description ? { Description: r.description } : {}),
            ...(r.severity ? { Severity: r.severity } : {}),
          },
        ].slice(-MAX_CODES);
      } else {
        b.faults = [
          ...b.faults,
          {
            vin,
            datetime,
            CodeIdentifier: r.code,
            ...(r.description ? { CodeDescription: r.description } : {}),
            ...(r.severity ? { CodeSeverity: r.severity } : {}),
          },
        ].slice(-MAX_CODES);
      }
    }
    ctx.persist();
    return json(200, { cautions: b.cautions, faults: b.faults });
  }
  return json(404, { error: `no CNH control at ${req.path}` });
}

export const cnhModule: VendorModule = {
  vendor: 'cnh',
  error: cnhError,
  handle(req, ctx) {
    if (req.path === '/identity/authorize') return authorize(req, ctx);
    if (req.path === '/identity/oauth/token') return token(req, ctx);
    if (req.path === '/identity/oauth/revoke') return revoke(req, ctx);
    if (req.path === '/v1' || req.path.startsWith('/v1/')) return api(req, ctx);
    return cnhError(404, `Not found: ${req.path} (not simulated)`);
  },
  control,
};
