/**
 * Base URLs and credentials per connector mode (plan §5: "Going live changes a base URL and
 * credentials, not code"). Sim mode is the live client against `${VENDOR_SIM_URL}/<vendor>`
 * with SIM_CREDENTIALS (src/sim/types.ts); sandbox/live use the vendor and the configured
 * credentials; replay (contracts-m1 §10) is the live client against `replayBaseUrl(<vendor>)`
 * (https://replay.invalid/<vendor>, never resolvable) with a fixed token, the fixture transport
 * being added by the client (`SamsaraClient.forMode`, `DeereClient.forReplay`); off never polls.
 *
 * 1f.2 (docs/contracts-1f.md part B): one resolver per telematics connection. Every host is
 * config with the default the vendor's official docs name (checked Oct 30, 2026): Deere's
 * platform and Equipment API hosts, MOTIVE_API_BASE, GEOTAB_SERVER, the AEMP providers' base
 * URLs, CNH's API and identity hosts per environment (staging = sandbox mode, production = live),
 * TERMINAL_API_BASE. Secrets are required only in sandbox/live. Replay is wired for Motive,
 * Geotab, AEMP and Terminal (`ReplaySource`, each builder's own `<source>/replay.ts` list, empty
 * until it adds fixtures: a replay poll then answers "replay: no fixture for …"). CNH has no
 * replay mode (its telemetry is XML only, the replay transport serves JSON, and no recording
 * exists yet; src/config.ts refuses CONNECTOR_CNH=replay).
 *
 * Owned by sync-health in 1f (docs/contracts-1f.md §1); every export below is frozen (§5.0:
 * additive changes only), part B's resolvers and constants included.
 */
import type { AempProviderConfig, Config } from '../config';
import { SIM_AEMP_PROVIDERS, SIM_CNH_AUTH, SIM_CREDENTIALS } from '../sim/types';
import { DEERE_AUTH_SERVER_ID } from './deere/schemas';
import {
  createReplayFetch,
  type ReplayFetchOptions,
  type ReplayFixture,
  replayBaseUrl,
} from './replay';
import type { Mode } from './types';

/** What replay-mode clients send as their credential (the fixture transport ignores it). */
export const REPLAY_CREDENTIAL = 'replay-token';

/** The config keys the connectors read (a subset of Config, so tests can pass their own). */
export type ConnectorConfig = Pick<
  Config,
  | 'VENDOR_SIM_URL'
  | 'PUBLIC_URL'
  | 'TOKEN_ENC_KEY'
  | 'DEERE_CLIENT_ID'
  | 'DEERE_CLIENT_SECRET'
  | 'SAMSARA_API_TOKEN'
  | 'MOTIVE_API_KEY'
> &
  Partial<
    Pick<
      Config,
      | 'DEERE_API_BASE'
      | 'DEERE_EQUIPMENT_API_BASE'
      | 'MOTIVE_API_BASE'
      | 'GEOTAB_SERVER'
      | 'GEOTAB_DATABASE'
      | 'GEOTAB_USERNAME'
      | 'GEOTAB_PASSWORD'
      | 'AEMP_PROVIDERS'
      | 'CNH_CLIENT_ID'
      | 'CNH_CLIENT_SECRET'
      | 'CNH_SUBSCRIPTION_KEY'
      | 'CNH_API_BASE'
      | 'CNH_AUTH_BASE'
      | 'CNH_AUDIENCE'
      | 'CNH_CONNECTION'
      | 'CNH_REDIRECT_URI'
      | 'TERMINAL_SECRET_KEY'
      | 'TERMINAL_CONNECTION_TOKEN'
      | 'TERMINAL_API_BASE'
    >
  >;

export class ConnectorModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorModeError';
  }
}

const trim = (u: string) => u.replace(/\/+$/, '');

function unsupported(vendor: string, mode: Mode): never {
  if (mode === 'replay') {
    throw new ConnectorModeError(`${vendor}: no replay mode (use sim, sandbox, live or off)`);
  }
  throw new ConnectorModeError(`${vendor}: mode '${mode}' does not poll`);
}

function required(value: string | undefined, key: string, vendor: string, mode: Mode): string {
  if (!value) throw new ConnectorModeError(`${vendor}: ${key} is required in ${mode} mode`);
  return value;
}

export interface SamsaraEndpoint {
  baseUrl: string;
  apiToken: string;
}

export function samsaraEndpoint(mode: Mode, cfg: ConnectorConfig): SamsaraEndpoint {
  switch (mode) {
    case 'sim':
      return {
        baseUrl: `${trim(cfg.VENDOR_SIM_URL)}/samsara`,
        apiToken: SIM_CREDENTIALS.samsara.apiToken,
      };
    case 'replay':
      return { baseUrl: replayBaseUrl('samsara'), apiToken: REPLAY_CREDENTIAL };
    case 'sandbox': // Samsara has no sandbox: a test org's token against the real API.
    case 'live':
      return {
        baseUrl: 'https://api.samsara.com',
        apiToken: required(cfg.SAMSARA_API_TOKEN, 'SAMSARA_API_TOKEN', 'samsara', mode),
      };
    default:
      return unsupported('samsara', mode);
  }
}

export interface MotiveEndpoint {
  baseUrl: string;
  apiKey: string;
}

export function motiveEndpoint(mode: Mode, cfg: ConnectorConfig): MotiveEndpoint {
  switch (mode) {
    case 'sim':
      return {
        baseUrl: `${trim(cfg.VENDOR_SIM_URL)}/motive`,
        apiKey: SIM_CREDENTIALS.motive.apiKey,
      };
    case 'replay':
      return { baseUrl: replayBaseUrl('motive'), apiKey: REPLAY_CREDENTIAL };
    case 'sandbox': // a TEST MODE key (a per-key checkbox) against the same host
    case 'live':
      return {
        baseUrl: trim(cfg.MOTIVE_API_BASE ?? MOTIVE_DEFAULT_BASE),
        apiKey: required(cfg.MOTIVE_API_KEY, 'MOTIVE_API_KEY', 'motive', mode),
      };
    default:
      return unsupported('motive', mode);
  }
}

/** Motive's API host (its Base URL page; api.keeptruckin.com is the legacy one). */
export const MOTIVE_DEFAULT_BASE = 'https://api.gomotive.com';

// ---- Geotab (MyGeotab JSON-RPC; trucks builder) ---------------------------------------------

export const GEOTAB_DEFAULT_SERVER = 'my.geotab.com';

export interface GeotabEndpoint {
  /**
   * JSON-RPC endpoint: https://<server>/apiv1. Authenticate may name another server
   * (`LoginResult.path`: a host name, "ThisServer", or absent: it is deprecated in api.json), so
   * the client keeps a runtime server override and falls back to this one when it fails.
   */
  apiUrl: string;
  server: string;
  database: string;
  /** The service user (sent on the wire as `userName`, in Authenticate params and credentials). */
  username: string;
  password: string;
}

export function geotabEndpoint(mode: Mode, cfg: ConnectorConfig): GeotabEndpoint {
  switch (mode) {
    case 'sim':
      return {
        apiUrl: `${trim(cfg.VENDOR_SIM_URL)}/geotab/apiv1`,
        server: new URL(cfg.VENDOR_SIM_URL).host,
        ...SIM_CREDENTIALS.geotab,
      };
    case 'replay':
      return {
        apiUrl: `${replayBaseUrl('geotab')}/apiv1`,
        server: 'replay.invalid',
        database: 'replay',
        username: 'replay',
        password: REPLAY_CREDENTIAL,
      };
    case 'sandbox': // the free demo database on the same servers
    case 'live': {
      const server = cfg.GEOTAB_SERVER ?? GEOTAB_DEFAULT_SERVER;
      return {
        apiUrl: `https://${server}/apiv1`,
        server,
        database: required(cfg.GEOTAB_DATABASE, 'GEOTAB_DATABASE', 'geotab', mode),
        username: required(cfg.GEOTAB_USERNAME, 'GEOTAB_USERNAME', 'geotab', mode),
        password: required(cfg.GEOTAB_PASSWORD, 'GEOTAB_PASSWORD', 'geotab', mode),
      };
    }
    default:
      return unsupported('geotab', mode);
  }
}

// ---- AEMP / ISO 15143-3 (machines builder) --------------------------------------------------

export interface AempEndpoint extends Omit<AempProviderConfig, 'baseUrl'> {
  /** The provider's ISO 15143-3 root (no trailing slash): `${baseUrl}/Fleet/{pageNumber}`. */
  baseUrl: string;
  /** What to send as `Accept` (from `format`: the standard is XML, JSON is a provider choice). */
  accept: string;
  /** Poll at most this often (s): the provider's own, else AEMP_DEFAULT_MIN_INTERVAL_SECONDS. */
  minIntervalSeconds: number;
}

/** A provider polled no more often than this unless it says otherwise (Trackunit: 1 per URL per 15 min). */
export const AEMP_DEFAULT_MIN_INTERVAL_SECONDS = 900;

/** Deere's documented ISO 15143-3 roots (an AEMP_PROVIDERS entry with auth `deere_oauth`). */
export const DEERE_AEMP_SANDBOX_BASE = 'https://sandboxaemp.deere.com';
export const DEERE_AEMP_LIVE_BASE = 'https://partneraemp.deere.com';
/** Samsara's ISO 15143-3 root (`GET /beta/aemp/Fleet/{pageNumber}`, Read AEMP scope). */
export const SAMSARA_AEMP_BASE = 'https://api.samsara.com/beta/aemp';

/** The Accept header a provider's `format` asks for. */
export function aempAccept(format: AempProviderConfig['format']): string {
  return format === 'json' ? 'application/json' : 'application/xml, application/json;q=0.9';
}

function aempNeeds(p: AempProviderConfig): (keyof AempProviderConfig)[] {
  switch (p.auth) {
    case 'none':
    case 'deere_oauth': // the Deere connection's grant (DEERE_CLIENT_ID/SECRET, checked below)
      return [];
    case 'bearer':
      return ['token'];
    case 'basic':
      return ['username', 'password'];
    case 'oauth2':
      return p.grantType === 'password'
        ? ['clientId', 'clientSecret', 'tokenUrl', 'username', 'password']
        : ['clientId', 'clientSecret', 'tokenUrl'];
    case 'subscription_key':
      return ['subscriptionKey'];
  }
}

const aempSim = (id: string, baseUrl: string, token: string): AempEndpoint => ({
  id,
  baseUrl,
  auth: 'bearer',
  token,
  // The stand-in mirrors each provider's documented format (Samsara JSON, the others XML).
  format: id === 'samsara' ? 'json' : 'auto',
  accept: aempAccept(id === 'samsara' ? 'json' : 'auto'),
  ...(id === 'samsara' ? { idElement: 'EquipmentID' as const } : {}),
  minIntervalSeconds: AEMP_DEFAULT_MIN_INTERVAL_SECONDS,
});

/**
 * The AEMP providers to poll. Sim: AEMP_PROVIDERS' ids (else SIM_AEMP_PROVIDERS: kubota, samsara)
 * against the stand-in at /aemp/<id>, bearer SIM_CREDENTIALS.aemp.token. Sandbox/live:
 * AEMP_PROVIDERS as configured, each with the secrets its auth style needs ([] when none is
 * configured); `deere_oauth` needs the Deere app (DEERE_CLIENT_ID / DEERE_CLIENT_SECRET).
 */
export function aempEndpoints(mode: Mode, cfg: ConnectorConfig): AempEndpoint[] {
  const providers = cfg.AEMP_PROVIDERS ?? [];
  switch (mode) {
    case 'sim': {
      const ids = providers.length ? providers.map((p) => p.id) : [...SIM_AEMP_PROVIDERS];
      return ids.map((id) =>
        aempSim(id, `${trim(cfg.VENDOR_SIM_URL)}/aemp/${id}`, SIM_CREDENTIALS.aemp.token),
      );
    }
    case 'replay': {
      const ids = providers.length ? providers.map((p) => p.id) : [...SIM_AEMP_PROVIDERS];
      return ids.map((id) => aempSim(id, `${replayBaseUrl('aemp')}/${id}`, REPLAY_CREDENTIAL));
    }
    case 'sandbox':
    case 'live':
      return providers.map((p) => {
        for (const k of aempNeeds(p)) {
          if (!p[k]) {
            throw new ConnectorModeError(
              `aemp: provider '${p.id}' (auth ${p.auth}) needs '${k}' in AEMP_PROVIDERS in ${mode} mode`,
            );
          }
        }
        if (p.auth === 'deere_oauth') {
          required(cfg.DEERE_CLIENT_ID, 'DEERE_CLIENT_ID', `aemp (provider '${p.id}')`, mode);
          required(
            cfg.DEERE_CLIENT_SECRET,
            'DEERE_CLIENT_SECRET',
            `aemp (provider '${p.id}')`,
            mode,
          );
        }
        return {
          ...p,
          baseUrl: trim(p.baseUrl),
          accept: aempAccept(p.format),
          minIntervalSeconds: p.minIntervalSeconds ?? AEMP_DEFAULT_MIN_INTERVAL_SECONDS,
        };
      });
    default:
      return unsupported('aemp', mode);
  }
}

// ---- CNH FieldOps (machines builder; a client to CNH's published OpenAPI) --------------------

/**
 * CNH FieldOps hosts per environment (developer portal "Base URLs" and "Environment Variables";
 * the OpenAPI spec's servers, SwaggerHub CNH/FieldOps-API 1.0.0). Staging and production are
 * separate apps with separate identities, credentials and data: sandbox mode = staging.
 */
export const CNH_ENVIRONMENTS = {
  staging: {
    apiBase: 'https://stg.api-data.cnh.com/v1',
    authBase: 'https://stg.identity.cnhind.com',
    audience: 'https://sandbox.api-data.cnh.com/',
    connection: 'STG-ADFS-CONN',
  },
  production: {
    apiBase: 'https://api-data.cnh.com/v1',
    authBase: 'https://identity.cnhind.com',
    audience: 'https://api-data.cnh.com/',
    connection: 'PROD-ADFS-CONN',
  },
} as const;
/** @deprecated use CNH_ENVIRONMENTS.production.apiBase (kept for imports). */
export const CNH_DEFAULT_API_BASE = CNH_ENVIRONMENTS.production.apiBase;
/** @deprecated use CNH_ENVIRONMENTS.production.authBase (kept for imports). */
export const CNH_DEFAULT_AUTH_BASE = CNH_ENVIRONMENTS.production.authBase;

export interface CnhEndpoints {
  /** API root: …/companies, …/equipment, …/Fleet/{page}, …/Fleet/Equipment/{vin}/{Series}/… */
  apiBase: string;
  /** Auth0 root: authorizeUrl, tokenUrl and revokeUrl below it. */
  authBase: string;
  /** GET: response_type, scope=offline_access, state, client_id, redirect_uri, audience, connection (all required). */
  authorizeUrl: string;
  /** POST form, client_secret_post (the secret in the body); the refresh grant sends redirect_uri too. */
  tokenUrl: string;
  /** POST JSON { client_id, client_secret, token }. */
  revokeUrl: string;
  audience: string;
  connection: string;
  clientId: string;
  clientSecret: string;
  /** Ocp-Apim-Subscription-Key on every API call (per app and environment). */
  subscriptionKey: string;
  redirectUri: string;
  /** CNH promotes an app from staging to production: sandbox = staging. */
  environment: 'sim' | 'staging' | 'production';
}

function cnhUrls(authBase: string) {
  return {
    authBase,
    authorizeUrl: `${authBase}/authorize`,
    tokenUrl: `${authBase}/oauth/token`,
    revokeUrl: `${authBase}/oauth/revoke`,
  };
}

export function cnhEndpoints(mode: Mode, cfg: ConnectorConfig): CnhEndpoints {
  const redirectUri = cfg.CNH_REDIRECT_URI ?? `${trim(cfg.PUBLIC_URL)}/api/oauth/cnh`;
  switch (mode) {
    case 'sim': {
      const base = `${trim(cfg.VENDOR_SIM_URL)}/cnh`;
      return {
        apiBase: `${base}/v1`,
        ...cnhUrls(`${base}/identity`),
        ...SIM_CNH_AUTH,
        ...SIM_CREDENTIALS.cnh,
        redirectUri,
        environment: 'sim',
      };
    }
    case 'sandbox':
    case 'live': {
      const environment = mode === 'sandbox' ? 'staging' : 'production';
      const d = CNH_ENVIRONMENTS[environment];
      return {
        apiBase: trim(cfg.CNH_API_BASE ?? d.apiBase),
        ...cnhUrls(trim(cfg.CNH_AUTH_BASE ?? d.authBase)),
        audience: cfg.CNH_AUDIENCE ?? d.audience,
        connection: cfg.CNH_CONNECTION ?? d.connection,
        clientId: required(cfg.CNH_CLIENT_ID, 'CNH_CLIENT_ID', 'cnh', mode),
        clientSecret: required(cfg.CNH_CLIENT_SECRET, 'CNH_CLIENT_SECRET', 'cnh', mode),
        subscriptionKey: required(cfg.CNH_SUBSCRIPTION_KEY, 'CNH_SUBSCRIPTION_KEY', 'cnh', mode),
        redirectUri,
        environment,
      };
    }
    default:
      return unsupported('cnh', mode);
  }
}

// ---- Terminal (terminal-pickups builder; stand-in only until sandbox access) -----------------

/** Terminal's hosts (its Environments page and the spec's servers; both answer). */
export const TERMINAL_SANDBOX_BASE = 'https://api.sandbox.withterminal.com/tsp/v1';
export const TERMINAL_LIVE_BASE = 'https://api.withterminal.com/tsp/v1';

export interface TerminalEndpoint {
  baseUrl: string;
  /** Authorization: Bearer <secret key> (sk_…). Alone it lists every connection (GET /connections). */
  secretKey: string;
  /**
   * Connection-Token header pinned by TERMINAL_CONNECTION_TOKEN, or null: discover the
   * connections with `GET /connections?status=connected` (one per hauler, each row carrying its
   * own `token`; tokens don't expire unless rotated).
   */
  connectionToken: string | null;
}

export function terminalEndpoint(mode: Mode, cfg: ConnectorConfig): TerminalEndpoint {
  switch (mode) {
    case 'sim':
      return {
        baseUrl: `${trim(cfg.VENDOR_SIM_URL)}/terminal/tsp/v1`,
        secretKey: SIM_CREDENTIALS.terminal.secretKey,
        // Discovery through the stand-in's GET /connections (its token: SIM_CREDENTIALS).
        connectionToken: null,
      };
    case 'replay':
      return {
        baseUrl: `${replayBaseUrl('terminal')}/tsp/v1`,
        secretKey: REPLAY_CREDENTIAL,
        connectionToken: null,
      };
    case 'sandbox':
    case 'live':
      return {
        baseUrl: trim(
          cfg.TERMINAL_API_BASE ??
            (mode === 'sandbox' ? TERMINAL_SANDBOX_BASE : TERMINAL_LIVE_BASE),
        ),
        secretKey: required(cfg.TERMINAL_SECRET_KEY, 'TERMINAL_SECRET_KEY', 'terminal', mode),
        connectionToken: cfg.TERMINAL_CONNECTION_TOKEN ?? null,
      };
    default:
      return unsupported('terminal', mode);
  }
}

// ---- John Deere --------------------------------------------------------------------------------

/** The Operations Center ("platform") hosts the developer portal documents. */
export const DEERE_SANDBOX_API_BASE = 'https://sandboxapi.deere.com/platform';
export const DEERE_LIVE_API_BASE = 'https://api.deere.com/platform';
/**
 * Deere's Equipment API (machines and implements; replaces the deprecated /platform machines
 * API): one host for sandbox and production apps, `Accept: application/json`.
 */
export const DEERE_EQUIPMENT_API_DEFAULT_BASE = 'https://equipmentapi.deere.com/isg';
/** Deere's Okta authorization server (the discovery document). */
export const DEERE_AUTH_BASE = `https://signin.johndeere.com/oauth2/${DEERE_AUTH_SERVER_ID}`;

export interface DeereEndpoints {
  /** Platform API root, e.g. https://sandboxapi.deere.com/platform. */
  apiBase: string;
  /**
   * Equipment API root (GET {equipmentBase}/equipment?organizationIds=…): machines are listed
   * here; their `principalId` is what the /platform machine paths take.
   */
  equipmentBase: string;
  /** OAuth authorization server root (…/oauth2/<id>); `/v1/authorize`, `/v1/token` below it. */
  authBase: string;
  clientId: string;
  clientSecret: string;
  /** The OAuth callback registered with Deere: `${PUBLIC_URL}/api/oauth/deere`. */
  redirectUri: string;
  /** True against the stand-in (enables the unattended sim-only consent). */
  sim: boolean;
}

export function deereEndpoints(mode: Mode, cfg: ConnectorConfig): DeereEndpoints {
  const redirectUri = `${trim(cfg.PUBLIC_URL)}/api/oauth/deere`;
  switch (mode) {
    case 'sim': {
      const base = `${trim(cfg.VENDOR_SIM_URL)}/deere`;
      return {
        apiBase: `${base}/platform`,
        equipmentBase: `${base}/isg`,
        authBase: `${base}/oauth2/${DEERE_AUTH_SERVER_ID}`,
        clientId: SIM_CREDENTIALS.deere.clientId,
        clientSecret: SIM_CREDENTIALS.deere.clientSecret,
        redirectUri,
        sim: true,
      };
    }
    case 'replay': {
      const base = replayBaseUrl('deere');
      return {
        apiBase: `${base}/platform`,
        equipmentBase: `${base}/isg`,
        authBase: `${base}/oauth2/${DEERE_AUTH_SERVER_ID}`,
        clientId: 'replay',
        clientSecret: REPLAY_CREDENTIAL,
        redirectUri,
        sim: false,
      };
    }
    case 'sandbox':
    case 'live':
      return {
        apiBase: trim(
          cfg.DEERE_API_BASE ?? (mode === 'sandbox' ? DEERE_SANDBOX_API_BASE : DEERE_LIVE_API_BASE),
        ),
        equipmentBase: trim(cfg.DEERE_EQUIPMENT_API_BASE ?? DEERE_EQUIPMENT_API_DEFAULT_BASE),
        authBase: DEERE_AUTH_BASE,
        clientId: required(cfg.DEERE_CLIENT_ID, 'DEERE_CLIENT_ID', 'deere', mode),
        clientSecret: required(cfg.DEERE_CLIENT_SECRET, 'DEERE_CLIENT_SECRET', 'deere', mode),
        redirectUri,
        sim: false,
      };
    default:
      return unsupported('deere', mode);
  }
}

/** Sources with replay fixtures (src/connectors/<source>/replay.ts; 1f.2: part B's four too). */
export type ReplaySource = 'deere' | 'samsara' | 'motive' | 'geotab' | 'aemp' | 'terminal';

const REPLAY_FIXTURES: Record<ReplaySource, () => Promise<readonly ReplayFixture[]>> = {
  deere: () => import('./deere/replay').then((m) => m.deereReplayFixtures),
  samsara: () => import('./samsara/replay').then((m) => m.samsaraReplayFixtures),
  motive: () => import('./motive/replay').then((m) => m.motiveReplayFixtures),
  geotab: () => import('./geotab/replay').then((m) => m.geotabReplayFixtures),
  aemp: () => import('./aemp/replay').then((m) => m.aempReplayFixtures),
  terminal: () => import('./terminal/replay').then((m) => m.terminalReplayFixtures),
};

/**
 * The replay transport for `source` (createReplayFetch over its committed fixtures). The fixture
 * module (a few hundred KB of JSON) loads on the first request, so sim and live never load it.
 */
export function replayFetch(
  source: ReplaySource,
  opts: ReplayFetchOptions & { fixtures?: readonly ReplayFixture[] } = {},
): typeof fetch {
  const { fixtures, ...fetchOpts } = opts;
  let ready: Promise<typeof fetch> | null = null;
  return async (input, init) => {
    ready ??= (fixtures ? Promise.resolve(fixtures) : REPLAY_FIXTURES[source]()).then((f) =>
      createReplayFetch(f, fetchOpts),
    );
    return (await ready)(input, init);
  };
}
