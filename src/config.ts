/**
 * src/config.ts: all configuration, zod-validated. THE ONLY MODULE THAT READS process.env
 * (Biome `noProcessEnv` + src/seams.test.ts enforce it).
 *
 * Env files are loaded with @next/env's `loadEnvConfig`, so tsx scripts, drizzle.config.ts and
 * tests see .env + .env.local exactly like Next does. One difference: Next skips .env.local when
 * NODE_ENV=test; we merge it anyway (never overriding), because the local database credentials
 * that DB tests need live there.
 *
 * Usage:
 *   const cfg = getConfig();            // server code, scripts (throws ConfigError with a fix-it message)
 *   getDevOrigins()                     // next.config.ts (never throws)
 *   publicConfig(getConfig())           // the client-safe subset, passed to client components as props
 *
 * Client components never read env: server components pass values down. (NEXT_PUBLIC_REALTIME is
 * still named NEXT_PUBLIC_ to match the plan; it is read here on the server.)
 *
 * Keep imports relative (no "@/"): drizzle-kit and next.config.ts load this file directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as nextEnvModule from '@next/env';
import { z } from 'zod';
import { CONNECTOR_MODES, type Mode, TRUCK_VENDORS, type TruckVendor } from './connectors/types';
import { parseVehicleKindTags, type VehicleKindTagRule } from './domain/vehicles';
import { SCENARIO_NAMES } from './sim/types';

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/.+/.test(v) && URL.canParse(v), 'must be a postgres:// URL');
const httpUrl = z.url({ protocol: /^https?$/ });
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const onOff = z.enum(['on', 'off']).transform((v) => v === 'on');
const connectorMode = z.enum(CONNECTOR_MODES).default('sim');
/** A per-vendor mode key: unset = sim locally, off in production (resolved below). */
const vendorMode = z.enum(CONNECTOR_MODES).optional();
const secret = z.string().min(1).optional();
const hex = (chars: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${chars}}$`), `must be ${chars} hex characters`);

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/**
 * The per-vendor telematics mode keys (1f.2, docs/contracts-1f.md part B): one connection each,
 * all of them able to run at once. Deere keeps CONNECTOR_DEERE, weather CONNECTOR_WEATHER.
 * Pickups have no key of their own: they ride on their telematics vendor's feeds (carmaker-cloud
 * integrations; decision D3), with VEHICLE_KIND_TAGS naming the vendor tags that make a vehicle a
 * pickup or a service truck.
 */
export const VENDOR_MODE_KEYS = [
  'CONNECTOR_SAMSARA',
  'CONNECTOR_MOTIVE',
  'CONNECTOR_GEOTAB',
  'CONNECTOR_AEMP',
  'CONNECTOR_CNH',
  'CONNECTOR_TERMINAL',
] as const;
export type VendorModeKey = (typeof VENDOR_MODE_KEYS)[number];

/** Every connector mode key (the production rules apply to each). */
export const CONNECTOR_MODE_KEYS = [
  'CONNECTOR_DEERE',
  ...VENDOR_MODE_KEYS,
  'CONNECTOR_WEATHER',
] as const;
export type ConnectorModeKey = (typeof CONNECTOR_MODE_KEYS)[number];

const TRUCK_VENDOR_KEY: Record<TruckVendor, VendorModeKey> = {
  samsara: 'CONNECTOR_SAMSARA',
  motive: 'CONNECTOR_MOTIVE',
  geotab: 'CONNECTOR_GEOTAB',
  terminal: 'CONNECTOR_TERMINAL',
};

/**
 * How an AEMP provider authenticates (AEMP_PROVIDERS[].auth; checked against each provider's
 * docs, Oct 30, 2026):
 *   none              no credentials (a test server)
 *   bearer            a static token (Samsara's API token, `Read AEMP` scope)
 *   basic             username + password (a dealer's ISO 15143-3 credentials, e.g. Kubota)
 *   oauth2            OAuth 2 token endpoint: client credentials (Trackunit Iris v2), or
 *                     `grantType: 'password'` with username + password (Trackunit v1)
 *   deere_oauth       the Deere connection's own user grant (Deere's ISO 15143-3 API at
 *                     partneraemp.deere.com takes the authorization-code token with scopes
 *                     `eq1 offline_access`; no extra credentials here)
 *   subscription_key  only an API-management key header (subscriptionKey)
 * A `subscriptionKey` may ride along with ANY style (CNH's APIM gateway takes the bearer token AND
 * `Ocp-Apim-Subscription-Key` on every call).
 */
export const AEMP_AUTH_STYLES = [
  'none',
  'bearer',
  'basic',
  'oauth2',
  'deere_oauth',
  'subscription_key',
] as const;
export type AempAuthStyle = (typeof AEMP_AUTH_STYLES)[number];

/** Which EquipmentHeader element is the provider's stable machine id (the external_refs id). */
export const AEMP_ID_ELEMENTS = ['PIN', 'VIN', 'SerialNumber', 'EquipmentID'] as const;

/**
 * One ISO 15143-3 (AEMP 2.0) provider (AEMP_PROVIDERS, a JSON array). The id is lower-case
 * letters and digits (it becomes the external_refs source_org and `aemp_<id>`). Secrets are
 * optional here: sim and replay need none; sandbox/live check the ones `auth` needs
 * (src/connectors/endpoints.ts `aempEndpoints`). Documented roots: Deere
 * https://partneraemp.deere.com (sandbox https://sandboxaemp.deere.com, XML), Samsara
 * https://api.samsara.com/beta/aemp (JSON wrapped in `{"Fleet": …}`), Trackunit
 * https://iris.trackunit.com/public/api/aemp/v2/15143/-3 (XML or JSON); Kubota: from the dealer.
 */
export const aempProviderSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]{1,20}$/, 'lower-case letters and digits, 2-21 long'),
  label: z.string().trim().min(1).max(60).optional(),
  /** The ISO 15143-3 root (…/Fleet/{pageNumber} below it), e.g. https://api.samsara.com/beta/aemp. */
  baseUrl: httpUrl,
  auth: z.enum(AEMP_AUTH_STYLES),
  token: secret,
  username: secret,
  password: secret,
  clientId: secret,
  clientSecret: secret,
  tokenUrl: httpUrl.optional(),
  /** `oauth2` only: client_credentials (default) or password (with username and password). */
  grantType: z.enum(['client_credentials', 'password']).optional(),
  scope: z.string().trim().min(1).optional(),
  /** An API-management key sent with ANY auth style (CNH: bearer + Ocp-Apim-Subscription-Key). */
  subscriptionKey: secret,
  /** Header name of `subscriptionKey` (default Ocp-Apim-Subscription-Key). */
  subscriptionKeyHeader: z.string().trim().min(1).optional(),
  /**
   * Response format; also what the client asks for (`Accept`): json → application/json; xml and
   * auto → application/xml, application/json;q=0.9. `auto` parses by Content-Type. Deere and CNH
   * document XML, Samsara JSON only (it answers 500 to Accept: application/xml).
   */
  format: z.enum(['auto', 'json', 'xml']).default('auto'),
  /**
   * The EquipmentHeader element that names a machine (unset: the first present of PIN, VIN,
   * SerialNumber, EquipmentID). Samsara: EquipmentID (its SerialNumber may be missing).
   */
  idElement: z.enum(AEMP_ID_ELEMENTS).optional(),
  /**
   * The provider's fault time series below baseUrl, if it has one, with `{id}`, `{start}`,
   * `{end}` and `{page}` placeholders (Trackunit: /Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}).
   * Unset: no fault series (Deere and Samsara document none).
   */
  faultsPath: z
    .string()
    .trim()
    .regex(/^\/.*\{id\}.*\{page\}/, 'a path with {id} and {page} (and {start}, {end})')
    .optional(),
  /**
   * Poll this provider at most this often (s). Unset: 900. Deere caches its feed for an hour and
   * asks for no more than hourly (3600); Trackunit allows one request per URL per 15 min (960
   * leaves room for clock jitter).
   */
  minIntervalSeconds: int(60, 86_400).optional(),
});
export type AempProviderConfig = z.infer<typeof aempProviderSchema>;

const aempProviders = z
  .string()
  .optional()
  .transform((v, ctx): AempProviderConfig[] => {
    if (!v) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON array of providers' });
      return z.NEVER;
    }
    const r = z.array(aempProviderSchema).safeParse(raw);
    if (!r.success) {
      const i = r.error.issues[0];
      ctx.addIssue({
        code: 'custom',
        message: `${i?.path.join('.') || '(list)'}: ${i?.message ?? 'invalid'}`,
      });
      return z.NEVER;
    }
    const ids = r.data.map((p) => p.id);
    const dup = ids.find((id, k) => ids.indexOf(id) !== k);
    if (dup) {
      ctx.addIssue({ code: 'custom', message: `provider '${dup}' is listed twice` });
      return z.NEVER;
    }
    return r.data;
  });

const vehicleKindTags = z
  .string()
  .optional()
  .transform((v, ctx): VehicleKindTagRule[] => {
    try {
      return parseVehicleKindTags(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  });

const baseSchema = z.object({
  /** development | test | production. `next start` on the PC is still development (pilot). */
  APP_ENV: z.enum(APP_ENVS).default('development'),

  // --- database -------------------------------------------------------------------------------
  /** App connection, as farm_app. Locally postgres://farm_app:…@127.0.0.1:15432/postgres. */
  DATABASE_URL: postgresUrl,
  /** Migrations/admin connection, as postgres (session pooler in production). Scripts only. */
  DATABASE_URL_MIGRATE: postgresUrl.optional(),
  /** Host port of the local container (compose reads it from .env). */
  DB_PORT: int(1, 65535).default(15432),
  /** postgres password of the local container (compose reads it from .env). Scripts only. */
  DB_PASSWORD: z.string().min(1).optional(),
  /** farm_app login password, applied by `pnpm db:configure local`. Scripts only. */
  FARM_APP_PASSWORD: z.string().min(1).optional(),
  /** Max connections of the page-request pool. */
  DB_POOL_MAX: int(1, 100).default(10),
  /** Max connections of the jobs pool (kept small so a sync never starves page requests). */
  DB_JOBS_POOL_MAX: int(1, 20).default(2),

  // --- app ------------------------------------------------------------------------------------
  /** Base URL people use; cookie `Secure` follows its scheme, never NODE_ENV. */
  PUBLIC_URL: httpUrl.default('http://localhost:3000'),
  /** Comma list for Next's allowedDevOrigins (LAN IPs + <hostname>.local), written by env:init. */
  DEV_ORIGINS: csv,
  /** Bearer secret for POST /api/jobs/<name>. */
  JOBS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Signs the local session cookie (jose). */
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** AES-256-GCM key (64 hex) for ingest.oauth_tokens.ciphertext. Required in production. */
  TOKEN_ENC_KEY: hex(64).optional(),
  AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  /** Client realtime adapter: sse (local /api/realtime) | supabase (Broadcast). */
  NEXT_PUBLIC_REALTIME: z.enum(['sse', 'supabase']).default('sse'),
  /**
   * protomaps-local (the offline PMTiles basemap) | openfreemap (online; a second style with its
   * own layer anchors, plan §1). Only protomaps-local is built so far, so openfreemap is refused
   * instead of being silently ignored.
   */
  BASEMAP_STYLE: z.enum(['protomaps-local', 'openfreemap']).default('protomaps-local'),
  /** Local storage adapter root (relative to the project). */
  STORAGE_DIR: z.string().min(1).default('.data/storage'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- jobs clock -----------------------------------------------------------------------------
  /** croner = tools/clock; pgcron = rehearse the production path (pg_cron + pg_net in the container). */
  CLOCK: z.enum(['croner', 'pgcron']).default('croner'),
  /** Which `host` values this clock fires (shop-PC worker after MD: 'pc'). */
  CLOCK_HOSTS: z
    .string()
    .default('app,pc')
    .transform((v, ctx) => {
      const hosts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const h of hosts) {
        if (h !== 'app' && h !== 'pc')
          ctx.addIssue({ code: 'custom', message: `unknown host '${h}'` });
      }
      return hosts as ('app' | 'pc')[];
    }),
  /**
   * Local demo cadence: tools/clock fires jobs that declare `demoEvery` at that interval
   * (fleet.trucks every 5 s instead of 30 s), but only while the job's connector is sim, replay
   * or off: a sandbox or live vendor keeps the job's real schedule. Never in production.
   * `pnpm env:init` turns it on for the PC demo.
   */
  JOBS_DEMO_CADENCE: onOff.default(false),
  /**
   * A machine whose latest fix is older than this is `stale` (plan 1a: 10 min). Applies to
   * sources that report continuously (ELD, cab device, manual).
   */
  FLEET_STALE_SECONDS: int(5, 86_400).default(600),
  /**
   * The same for machines whose latest fix came from Deere (`deere_working`): Deere only records
   * positions while a machine is working, so an idle cart has no new fix for minutes at a time.
   */
  FLEET_STALE_SECONDS_DEERE: int(5, 86_400).default(600),
  /**
   * 1f.2: the same for `last_known` fixes (AEMP hourly snapshots, cached up to an hour by the
   * OEM; Terminal's latest location). Default 3 h.
   */
  FLEET_STALE_SECONDS_LAST_KNOWN: int(5, 7 * 86_400).default(10_800),

  // --- connectors -----------------------------------------------------------------------------
  /**
   * Vendor stand-in base URL; sim-mode clients use `${VENDOR_SIM_URL}/<vendor>`. Loopback only
   * (the stand-in never listens on the LAN, and sim-mode traffic never leaves the PC).
   */
  VENDOR_SIM_URL: httpUrl
    .refine(
      (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname),
      'the vendor stand-in is loopback-only: use http://127.0.0.1:<port>',
    )
    .default('http://127.0.0.1:4010'),
  CONNECTOR_DEERE: connectorMode,
  CONNECTOR_WEATHER: connectorMode,
  /**
   * 1f.2: one mode key per telematics connection (sim | replay | sandbox | live | off). Unset =
   * sim locally (the demo board shows the mixed fleet), off in production. Production refuses
   * sim and replay per key.
   */
  CONNECTOR_SAMSARA: vendorMode,
  CONNECTOR_MOTIVE: vendorMode,
  CONNECTOR_GEOTAB: vendorMode,
  CONNECTOR_AEMP: vendorMode,
  CONNECTOR_CNH: vendorMode,
  CONNECTOR_TERMINAL: vendorMode,
  /**
   * DEPRECATED (1f.2): read only as an alias. `CONNECTOR_ELD=<mode>` sets the key of the vendor
   * ELD_VENDOR names (default samsara) unless that key is set itself; /admin/connectors shows a
   * warning until .env.local uses the new key. Not part of Config after parsing.
   */
  CONNECTOR_ELD: z.enum(CONNECTOR_MODES).optional(),
  /** DEPRECATED (1f.2): the vendor CONNECTOR_ELD applies to (samsara, motive, geotab, terminal). */
  ELD_VENDOR: z.enum(TRUCK_VENDORS).optional(),
  /** Deere Work Plan push. Off by default: the PC can never push to the real org. */
  WRITEBACK_DEERE: onOff.default(false),
  DEERE_CLIENT_ID: z.string().min(1).optional(),
  DEERE_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * The Deere OAuth callback when it isn't `${PUBLIC_URL}/api/oauth/deere` (1f decision 6): a
   * public HTTPS page registered with the Deere app that forwards `code` and `state` to the PC
   * (template docs/deere-callback.html). Unset: `${PUBLIC_URL}/api/oauth/deere`.
   */
  DEERE_REDIRECT_URI: httpUrl.optional(),
  /**
   * Deere API calls the app may make per day (1f decision 4). Unset: the limit is unknown, the
   * Deere jobs keep their cron and /admin/connectors says "limit unknown". Set: fleet.deere paces
   * itself to stay under 80 % of it (never faster than its cron).
   */
  DEERE_DAILY_CALL_BUDGET: int(1, 100_000_000).optional(),
  /**
   * The Deere organization that is your own operation (1f, docs/contracts-1f.md §5.4): machines
   * are created only from it, and farms from any other org belong to that org's customer. Unset:
   * sim and replay use their simulated home org; sandbox and live use the only org you are a
   * member of when there is exactly one, else there is no home org and /admin/connectors asks
   * for this setting (src/connectors/deere/orgs.ts `deereHomeOrg`).
   */
  DEERE_HOME_ORG_ID: z.string().trim().min(1).max(200).optional(),
  /**
   * Deere Operations Center API root when it isn't the documented one (sandbox
   * https://sandboxapi.deere.com/platform, live https://api.deere.com/platform).
   */
  DEERE_API_BASE: httpUrl.optional(),
  /**
   * Deere's Equipment API root, where machines are listed (the old /platform machines API is
   * deprecated). Unset: https://equipmentapi.deere.com/isg, the same host for sandbox and live
   * apps (Deere's docs).
   */
  DEERE_EQUIPMENT_API_BASE: httpUrl.optional(),
  SAMSARA_API_TOKEN: z.string().min(1).optional(),
  /**
   * Motive company API key (X-Api-Key): a hauler's key from Admin > Developers > API Access,
   * read-only scoped, optionally Group-scoped to the trucks on our job and set to expire.
   */
  MOTIVE_API_KEY: z.string().min(1).optional(),
  /** Motive API root. Unset: https://api.gomotive.com (api.keeptruckin.com is the legacy host). */
  MOTIVE_API_BASE: httpUrl.optional(),
  /** MyGeotab server host (JSON-RPC at https://<server>/apiv1). Unset: my.geotab.com. */
  GEOTAB_SERVER: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+$/i, 'a host name, e.g. my.geotab.com')
    .optional(),
  /** MyGeotab database name (sandbox: your free demo database). */
  GEOTAB_DATABASE: secret,
  /** MyGeotab service user (a user made for the API, never a person's login). */
  GEOTAB_USERNAME: secret,
  GEOTAB_PASSWORD: secret,
  /**
   * ISO 15143-3 (AEMP 2.0) providers, a JSON array: `[{"id":"kubota","baseUrl":"https://…",
   * "auth":"basic","username":"…","password":"…"}]` (aempProviderSchema). Unset: in sim and
   * replay the stand-in's providers (cnh, kubota, samsara); in sandbox/live nothing to poll.
   */
  AEMP_PROVIDERS: aempProviders,
  /**
   * CNH FieldOps OAuth client of the develop.cnh.com app FOR THIS ENVIRONMENT (staging = sandbox
   * mode, production = live; promoting the app to production issues new credentials).
   */
  CNH_CLIENT_ID: secret,
  CNH_CLIENT_SECRET: secret,
  /** CNH API subscription key (Ocp-Apim-Subscription-Key on every call; per app and environment). */
  CNH_SUBSCRIPTION_KEY: secret,
  /**
   * CNH FieldOps API root. Unset: https://stg.api-data.cnh.com/v1 (sandbox = staging) or
   * https://api-data.cnh.com/v1 (live = production).
   */
  CNH_API_BASE: httpUrl.optional(),
  /**
   * CNH identity (Auth0) root: /authorize, /oauth/token, /oauth/revoke below it. Unset:
   * https://stg.identity.cnhind.com (sandbox) or https://identity.cnhind.com (live).
   */
  CNH_AUTH_BASE: httpUrl.optional(),
  /**
   * The OAuth `audience` /authorize requires. Unset: https://sandbox.api-data.cnh.com/ (sandbox)
   * or https://api-data.cnh.com/ (live).
   */
  CNH_AUDIENCE: z.string().trim().min(1).optional(),
  /**
   * The Auth0 `connection` /authorize requires. Unset: STG-ADFS-CONN (sandbox) or PROD-ADFS-CONN
   * (live) for agriculture; construction accounts use CNHI-OPENID-CON(-PROD).
   */
  CNH_CONNECTION: z.string().trim().min(1).optional(),
  /** CNH OAuth callback when it isn't `${PUBLIC_URL}/api/oauth/cnh` (https in production). */
  CNH_REDIRECT_URI: httpUrl.optional(),
  /** Terminal secret key (Authorization: Bearer sk_…; lists every connection with GET /connections). */
  TERMINAL_SECRET_KEY: secret,
  /**
   * Optional pin to one Terminal connection (Connection-Token header, con_tkn_…). Unset: every
   * connection `GET /connections?status=connected` lists (one per hauler), each with its own
   * token.
   */
  TERMINAL_CONNECTION_TOKEN: secret,
  /** Terminal API root. Unset: sandbox https://api.sandbox.withterminal.com/tsp/v1, live https://api.withterminal.com/tsp/v1. */
  TERMINAL_API_BASE: httpUrl.optional(),
  /**
   * Pickups and service trucks (1f.2): which vendor tags set a vehicle's kind, as
   * `<kind>:<tag name>` pairs, e.g. `pickup:Pickups,service_truck:Service,semi:Semi`. Unset:
   * semi:Semi, pickup:Pickup, service_truck:Service truck. A kind set on /admin always wins.
   */
  VEHICLE_KIND_TAGS: vehicleKindTags,
  /** NWS requires a User-Agent with contact info. */
  NWS_USER_AGENT: z.string().min(1).default('farm-manager (local development)'),

  // --- simulator ------------------------------------------------------------------------------
  SIM_SCENARIO: z.enum(SCENARIO_NAMES).default('harvest-day'),
  SIM_SEED: int(0, 2_147_483_647).default(1),
  /** Sim seconds per wall second. */
  SIM_SPEED: z.coerce.number().positive().max(3600).default(1),
  /** Freeze sim time at this ISO instant (deterministic screenshots and tests). */
  SIM_FROZEN_AT: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
});

/** A note for /admin/connectors about the deprecated CONNECTOR_ELD / ELD_VENDOR keys. */
export interface ConnectorAliasNote {
  /** The deprecated keys that were set. */
  keys: ('CONNECTOR_ELD' | 'ELD_VENDOR')[];
  /** The key CONNECTOR_ELD set (or would have set), if any. */
  sets: VendorModeKey | null;
  /** Plain-words warning with the fix. */
  message: string;
}

type BaseEnv = z.infer<typeof baseSchema>;
type ResolvedModes = Record<VendorModeKey, Mode>;

/**
 * The per-vendor modes from the keys, the deprecated alias and the defaults (pure):
 *  1. a vendor key that is set wins;
 *  2. else `CONNECTOR_ELD` sets the key of ELD_VENDOR's vendor (default samsara);
 *  3. else sim locally, off in production.
 * Plus the notes /admin/connectors shows while a deprecated key is set.
 */
export function resolveConnectorModes(
  c: {
    APP_ENV: AppEnv;
    CONNECTOR_ELD?: Mode;
    ELD_VENDOR?: TruckVendor;
  } & Partial<Record<VendorModeKey, Mode | undefined>>,
): {
  modes: ResolvedModes;
  aliasNotes: ConnectorAliasNote[];
  /** Which keys came from the alias (for production error messages). */
  fromAlias: VendorModeKey[];
} {
  const fallback: Mode = c.APP_ENV === 'production' ? 'off' : 'sim';
  const modes = {} as ResolvedModes;
  for (const k of VENDOR_MODE_KEYS) modes[k] = c[k] ?? fallback;
  const aliasNotes: ConnectorAliasNote[] = [];
  const fromAlias: VendorModeKey[] = [];
  const vendor = c.ELD_VENDOR ?? 'samsara';
  const target = TRUCK_VENDOR_KEY[vendor];
  if (c.CONNECTOR_ELD !== undefined) {
    const keys: ConnectorAliasNote['keys'] = c.ELD_VENDOR
      ? ['CONNECTOR_ELD', 'ELD_VENDOR']
      : ['CONNECTOR_ELD'];
    const was = c.ELD_VENDOR
      ? `CONNECTOR_ELD=${c.CONNECTOR_ELD} (ELD_VENDOR=${vendor})`
      : `CONNECTOR_ELD=${c.CONNECTOR_ELD}`;
    if (c[target] === undefined) {
      modes[target] = c.CONNECTOR_ELD;
      fromAlias.push(target);
      aliasNotes.push({
        keys,
        sets: target,
        message: `${was} is deprecated: it set ${target}=${c.CONNECTOR_ELD}. Write ${target}=${c.CONNECTOR_ELD} in .env.local and delete ${keys.join(' and ')}. It sets that one vendor only: the others keep their own keys (unset: ${fallback}).`,
      });
    } else {
      aliasNotes.push({
        keys,
        sets: null,
        message: `${was} is deprecated and ignored: ${target} is set (${c[target]}). Delete ${keys.join(' and ')} from .env.local.`,
      });
    }
  } else if (c.ELD_VENDOR !== undefined) {
    aliasNotes.push({
      keys: ['ELD_VENDOR'],
      sets: null,
      message: `ELD_VENDOR=${c.ELD_VENDOR} is deprecated and does nothing on its own: every vendor has its own key now (${target}=…). Delete ELD_VENDOR from .env.local.`,
    });
  }
  return { modes, aliasNotes, fromAlias };
}

const resolvedSchema = baseSchema.transform((b) => {
  const { CONNECTOR_ELD, ELD_VENDOR, ...rest } = b;
  const r = resolveConnectorModes(b);
  return {
    ...rest,
    ...r.modes,
    /** Deprecated-key warnings (1f.2): shown on /admin/connectors. */
    connectorAliasNotes: r.aliasNotes,
    /** Keys whose mode came from CONNECTOR_ELD (for error messages). */
    connectorModesFromAlias: r.fromAlias,
    /** The raw deprecated values, for /admin/connectors only (never used to choose a mode). */
    deprecatedConnectorEld: CONNECTOR_ELD ?? null,
    deprecatedEldVendor: ELD_VENDOR ?? null,
  };
});

const configSchema = resolvedSchema.superRefine((c, ctx) => {
  if (c.BASEMAP_STYLE === 'openfreemap') {
    ctx.addIssue({
      code: 'custom',
      path: ['BASEMAP_STYLE'],
      message:
        "'openfreemap': the online style is not built yet (plan §1); use protomaps-local (the default)",
    });
  }
  const modes: [ConnectorModeKey, Mode][] = CONNECTOR_MODE_KEYS.map((k) => [k, c[k]]);
  // CNH's telemetry is XML only and the replay transport answers JSON fixtures, and no CNH
  // recording exists yet: CNH runs in sim (its stand-in) until a staging recording lands.
  if (c.CONNECTOR_CNH === 'replay') {
    ctx.addIssue({
      code: 'custom',
      path: ['CONNECTOR_CNH'],
      message: "CNH has no replay fixtures: use 'sim' (its stand-in), 'sandbox', 'live' or 'off'",
    });
  }
  // The demo cadence never runs in production. Locally it may stay on while a connector is live:
  // tools/clock applies it only to jobs whose connector is sim, replay or off (src/jobs/schedule.ts
  // `demoCadenceApplies`), so a live vendor is always polled at the job's real schedule.
  if (c.JOBS_DEMO_CADENCE && c.APP_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['JOBS_DEMO_CADENCE'],
      message: 'not allowed in production',
    });
  }
  if (c.APP_ENV !== 'production') return;
  for (const [key, mode] of modes) {
    if (mode === 'sim' || mode === 'replay') {
      const viaAlias = (c.connectorModesFromAlias as readonly string[]).includes(key);
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `'${mode}' is not allowed when APP_ENV=production (use live, sandbox or off)${viaAlias ? ' (set by the deprecated CONNECTOR_ELD)' : ''}`,
      });
    }
  }
  if (c.SIM_FROZEN_AT) {
    ctx.addIssue({ code: 'custom', path: ['SIM_FROZEN_AT'], message: 'not allowed in production' });
  }
  if (!c.TOKEN_ENC_KEY) {
    ctx.addIssue({ code: 'custom', path: ['TOKEN_ENC_KEY'], message: 'required in production' });
  }
  if (!c.PUBLIC_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_URL'],
      message: 'must be https:// in production',
    });
  }
  for (const key of ['DEERE_REDIRECT_URI', 'CNH_REDIRECT_URI'] as const) {
    const v = c[key];
    if (v && !v.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be https:// in production' });
    }
  }
  if (c.NEXT_PUBLIC_REALTIME === 'sse') {
    ctx.addIssue({
      code: 'custom',
      path: ['NEXT_PUBLIC_REALTIME'],
      message: "'sse' is local-only; use 'supabase' in production",
    });
  }
});

type ParsedEnv = z.infer<typeof resolvedSchema>;

export interface Config extends ParsedEnv {
  /** Project root the env files were loaded from. */
  projectDir: string;
  isProduction: boolean;
  /** Cookie `Secure` flag: follows PUBLIC_URL's scheme. */
  cookieSecure: boolean;
}

/** Keys the schema knows about (for docs and tests): every env key read, the deprecated ones included. */
export const CONFIG_KEYS = Object.keys(baseSchema.shape) as (keyof BaseEnv)[];

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `Invalid configuration:\n  - ${issues.join('\n  - ')}\n` +
        'Run `pnpm env:init` to create .env and .env.local, or fix the values above.',
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EnvLike = Record<string, string | undefined>;

/** Pure: validate an env-like object. Empty strings count as unset. */
export function parseConfig(env: EnvLike, projectDir: string = process.cwd()): Config {
  const input: EnvLike = {};
  for (const key of CONFIG_KEYS) {
    const v = env[key];
    input[key] = v === '' ? undefined : v;
  }
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`),
    );
  }
  const c = result.data;
  return {
    ...c,
    projectDir,
    isProduction: c.APP_ENV === 'production',
    cookieSecure: c.PUBLIC_URL.startsWith('https://'),
  };
}

// ---------------------------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------------------------

type NextEnvModule = typeof import('@next/env');
// @next/env is CommonJS without detectable named exports: under Node ESM only `default` exists.
const nextEnv: NextEnvModule =
  (nextEnvModule as unknown as { default?: NextEnvModule }).default ?? nextEnvModule;

const quietLog = { info: () => {}, error: (...args: unknown[]) => console.error(...args) };
let loadedDir: string | null = null;

/**
 * Load .env* files into process.env like Next does (existing variables win).
 * Idempotent per process; the first projectDir wins (Next caches the same way).
 */
export function loadEnvFiles(projectDir: string = process.cwd()): void {
  if (loadedDir !== null) return;
  loadedDir = projectDir;
  const nodeEnv = process.env.NODE_ENV;
  nextEnv.loadEnvConfig(projectDir, nodeEnv !== 'production', quietLog);
  if (nodeEnv === 'test') {
    const local = path.join(projectDir, '.env.local');
    if (existsSync(local)) {
      const parsed = parseEnv(readFileSync(local, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  }
}

let cached: Config | null = null;

/** The validated config (memoized). Throws ConfigError with a readable, fix-it message. */
export function getConfig(): Config {
  if (cached) return cached;
  const dir = process.cwd();
  loadEnvFiles(dir);
  cached = parseConfig(process.env, dir);
  return cached;
}

/** Like getConfig but returns the error instead of throwing (health checks, dry runs). */
export function tryGetConfig(): { ok: true; config: Config } | { ok: false; error: ConfigError } {
  try {
    return { ok: true, config: getConfig() };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, error: e };
    throw e;
  }
}

/** For next.config.ts: Next's allowedDevOrigins. Never throws (a fresh clone has no .env.local). */
export function getDevOrigins(): string[] {
  loadEnvFiles(process.cwd());
  return csv.parse(process.env.DEV_ORIGINS ?? '');
}

/** The admin/migrations URL (postgres role). Throws a fix-it message when missing. */
export function getMigrateUrl(): string {
  const url = tryGetMigrateUrl();
  if (!url) {
    throw new ConfigError(['DATABASE_URL_MIGRATE: required for database scripts']);
  }
  return url;
}

/** The admin URL if configured (no validation of the rest of the config). */
export function tryGetMigrateUrl(): string | undefined {
  loadEnvFiles(process.cwd());
  const v = process.env.DATABASE_URL_MIGRATE;
  return v ? postgresUrl.parse(v) : undefined;
}

/** Settings for playwright.config.ts (test tooling, not app config). */
export interface E2eSettings {
  /** E2E_BASE_URL, else PUBLIC_URL (so a parallel agent's own port is used), else localhost:3000. */
  baseURL: string;
  /** CI is set to anything but '', '0' or 'false' (GitHub Actions sets CI=true). */
  ci: boolean;
  /** E2E_BASE_URL was given: test that app as is (no webServer). */
  external: boolean;
}

/** Pure: E2E settings from an env-like object. Throws ConfigError only for a malformed E2E_BASE_URL. */
export function parseE2eSettings(env: EnvLike): E2eSettings {
  const explicit = env.E2E_BASE_URL?.trim();
  let baseURL = 'http://localhost:3000';
  if (explicit) {
    const r = httpUrl.safeParse(explicit);
    if (!r.success) throw new ConfigError(['E2E_BASE_URL: must be an http(s) URL']);
    baseURL = r.data;
  } else {
    const pub = httpUrl.safeParse(env.PUBLIC_URL?.trim());
    if (pub.success) baseURL = pub.data;
  }
  const ciRaw = (env.CI ?? '').trim().toLowerCase();
  return { baseURL, ci: ciRaw !== '' && ciRaw !== '0' && ciRaw !== 'false', external: !!explicit };
}

/**
 * For playwright.config.ts: loads the env files like everything else (so .env.development.local
 * overrides apply) and never needs the app's secrets, so it works in a fresh clone.
 */
export function getE2eSettings(): E2eSettings {
  loadEnvFiles(process.cwd());
  return parseE2eSettings(process.env);
}

/** Client-safe subset. Server components pass it to client components as props. */
export interface PublicConfig {
  appEnv: AppEnv;
  realtime: 'sse' | 'supabase';
  basemapStyle: 'protomaps-local' | 'openfreemap';
  /** FLEET_STALE_SECONDS (ELD, cab device, manual fixes). */
  staleAfterSeconds: number;
  /** FLEET_STALE_SECONDS_DEERE (Deere working-only fixes). */
  deereStaleAfterSeconds: number;
  /** FLEET_STALE_SECONDS_LAST_KNOWN (1f.2: vendor snapshots, AEMP). */
  lastKnownStaleAfterSeconds: number;
}
export function publicConfig(c: Config): PublicConfig {
  return {
    appEnv: c.APP_ENV,
    realtime: c.NEXT_PUBLIC_REALTIME,
    basemapStyle: c.BASEMAP_STYLE,
    staleAfterSeconds: c.FLEET_STALE_SECONDS,
    deereStaleAfterSeconds: c.FLEET_STALE_SECONDS_DEERE,
    lastKnownStaleAfterSeconds: c.FLEET_STALE_SECONDS_LAST_KNOWN,
  };
}

/**
 * Environment for a child process: the current environment plus overrides
 * (`undefined` removes a key). Scripts use this instead of touching process.env.
 */
export function childEnv(overrides: EnvLike = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Test-only: forget the memoized config (env files stay loaded). */
export function resetConfigCache(): void {
  cached = null;
}
