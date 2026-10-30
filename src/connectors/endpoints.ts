/**
 * Base URLs and credentials per connector mode (plan §5: "Going live changes a base URL and
 * credentials, not code"). Sim mode is the live client against `${VENDOR_SIM_URL}/<vendor>`
 * with SIM_CREDENTIALS (src/sim/types.ts); sandbox/live use the vendor and the configured
 * credentials; replay (contracts-m1 §10) is the live client against `replayBaseUrl(<vendor>)`
 * (https://replay.invalid/<vendor>, never resolvable) with a fixed token, the fixture transport
 * being added by the client (`SamsaraClient.forMode`, `DeereClient.forReplay`); off never polls.
 *
 * 1f.2 (docs/contracts-1f.md part B): one resolver per telematics connection. Hosts and paths
 * that aren't confirmed are config with a doc-derived default (`// doc-derived, confirm`, listed
 * in DOC_DERIVED): MOTIVE_API_BASE, GEOTAB_SERVER, the AEMP providers' base URLs, CNH_API_BASE /
 * CNH_AUTH_BASE, TERMINAL_API_BASE. Secrets are required only in sandbox/live. Replay is wired
 * for Motive, Geotab, AEMP and Terminal (`ReplaySource`, each builder's own `<source>/replay.ts`
 * list, empty until it adds fixtures: a replay poll then answers "replay: no fixture for …").
 * CNH has no replay mode (no fixtures for unconfirmed shapes).
 */
import type { AempProviderConfig, Config } from '../config';
import { SIM_AEMP_PROVIDERS, SIM_CREDENTIALS } from '../sim/types';
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
    throw new ConnectorModeError(
      `${vendor}: no replay fixtures yet (use sim; CONNECTOR_SAMSARA=replay replays the trucks)`,
    );
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
    case 'sandbox': // Motive's TEST MODE key against the same host (doc-derived, confirm)
    case 'live':
      return {
        baseUrl: trim(cfg.MOTIVE_API_BASE ?? MOTIVE_DEFAULT_BASE),
        apiKey: required(cfg.MOTIVE_API_KEY, 'MOTIVE_API_KEY', 'motive', mode),
      };
    default:
      return unsupported('motive', mode);
  }
}

/** Motive's current API host (api.keeptruckin.com is the legacy one). */
export const MOTIVE_DEFAULT_BASE = 'https://api.gomotive.com'; // doc-derived, confirm

// ---- Geotab (MyGeotab JSON-RPC; trucks builder) ---------------------------------------------

export const GEOTAB_DEFAULT_SERVER = 'my.geotab.com';

export interface GeotabEndpoint {
  /** JSON-RPC endpoint: https://<server>/apiv1 (Authenticate may redirect to another server). */
  apiUrl: string;
  server: string;
  database: string;
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
}

const AEMP_NEEDS: Record<AempProviderConfig['auth'], (keyof AempProviderConfig)[]> = {
  none: [],
  bearer: ['token'],
  basic: ['username', 'password'],
  oauth2: ['clientId', 'clientSecret', 'tokenUrl'],
  subscription_key: ['subscriptionKey'],
};

/**
 * The AEMP providers to poll. Sim: AEMP_PROVIDERS' ids (else SIM_AEMP_PROVIDERS) against the
 * stand-in at /aemp/<id>, bearer SIM_CREDENTIALS.aemp.token. Sandbox/live: AEMP_PROVIDERS as
 * configured, each with the secrets its auth style needs ([] when none is configured).
 */
export function aempEndpoints(mode: Mode, cfg: ConnectorConfig): AempEndpoint[] {
  const providers = cfg.AEMP_PROVIDERS ?? [];
  switch (mode) {
    case 'sim': {
      const ids = providers.length ? providers.map((p) => p.id) : [...SIM_AEMP_PROVIDERS];
      return ids.map((id) => ({
        id,
        baseUrl: `${trim(cfg.VENDOR_SIM_URL)}/aemp/${id}`,
        auth: 'bearer',
        token: SIM_CREDENTIALS.aemp.token,
        format: 'auto',
      }));
    }
    case 'replay': {
      const ids = providers.length ? providers.map((p) => p.id) : [...SIM_AEMP_PROVIDERS];
      return ids.map((id) => ({
        id,
        baseUrl: `${replayBaseUrl('aemp')}/${id}`,
        auth: 'bearer',
        token: REPLAY_CREDENTIAL,
        format: 'auto',
      }));
    }
    case 'sandbox':
    case 'live':
      return providers.map((p) => {
        for (const k of AEMP_NEEDS[p.auth]) {
          if (!p[k]) {
            throw new ConnectorModeError(
              `aemp: provider '${p.id}' (auth ${p.auth}) needs '${k}' in AEMP_PROVIDERS in ${mode} mode`,
            );
          }
        }
        return { ...p, baseUrl: trim(p.baseUrl) };
      });
    default:
      return unsupported('aemp', mode);
  }
}

// ---- CNH FieldOps (machines builder; scaffolding until the portal account) -------------------

/** CNH FieldOps API root: Leaf's guide (matches the OAuth audience); api.fieldops.cnh.com per a third party. */
export const CNH_DEFAULT_API_BASE = 'https://api-data.cnh.com/v1'; // doc-derived, confirm
export const CNH_DEFAULT_AUTH_BASE = 'https://identity.cnhind.com'; // doc-derived, confirm

export interface CnhEndpoints {
  apiBase: string;
  /** OAuth server root (authorize and token paths are config of the client, doc-derived). */
  authBase: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  redirectUri: string;
  /** CNH promotes an app from staging to production: sandbox = staging. */
  environment: 'sim' | 'staging' | 'production';
}

export function cnhEndpoints(mode: Mode, cfg: ConnectorConfig): CnhEndpoints {
  const redirectUri = cfg.CNH_REDIRECT_URI ?? `${trim(cfg.PUBLIC_URL)}/api/oauth/cnh`;
  switch (mode) {
    case 'sim': {
      const base = `${trim(cfg.VENDOR_SIM_URL)}/cnh`;
      return {
        apiBase: `${base}/api`,
        authBase: `${base}/identity`,
        ...SIM_CREDENTIALS.cnh,
        redirectUri,
        environment: 'sim',
      };
    }
    case 'sandbox':
    case 'live':
      return {
        apiBase: trim(cfg.CNH_API_BASE ?? CNH_DEFAULT_API_BASE),
        authBase: trim(cfg.CNH_AUTH_BASE ?? CNH_DEFAULT_AUTH_BASE),
        clientId: required(cfg.CNH_CLIENT_ID, 'CNH_CLIENT_ID', 'cnh', mode),
        clientSecret: required(cfg.CNH_CLIENT_SECRET, 'CNH_CLIENT_SECRET', 'cnh', mode),
        subscriptionKey: required(cfg.CNH_SUBSCRIPTION_KEY, 'CNH_SUBSCRIPTION_KEY', 'cnh', mode),
        redirectUri,
        environment: mode === 'sandbox' ? 'staging' : 'production',
      };
    default:
      return unsupported('cnh', mode);
  }
}

// ---- Terminal (terminal-pickups builder; stand-in only until sandbox access) -----------------

export const TERMINAL_SANDBOX_BASE = 'https://api.sandbox.withterminal.com/tsp/v1';
export const TERMINAL_LIVE_BASE = 'https://api.withterminal.com/tsp/v1'; // doc-derived, confirm

export interface TerminalEndpoint {
  baseUrl: string;
  /** Authorization: Bearer <secret key>. */
  secretKey: string;
  /** Connection-Token header: one linked carrier account. */
  connectionToken: string;
}

export function terminalEndpoint(mode: Mode, cfg: ConnectorConfig): TerminalEndpoint {
  switch (mode) {
    case 'sim':
      return {
        baseUrl: `${trim(cfg.VENDOR_SIM_URL)}/terminal/tsp/v1`,
        ...SIM_CREDENTIALS.terminal,
      };
    case 'replay':
      return {
        baseUrl: `${replayBaseUrl('terminal')}/tsp/v1`,
        secretKey: REPLAY_CREDENTIAL,
        connectionToken: REPLAY_CREDENTIAL,
      };
    case 'sandbox':
    case 'live':
      return {
        baseUrl: trim(
          cfg.TERMINAL_API_BASE ??
            (mode === 'sandbox' ? TERMINAL_SANDBOX_BASE : TERMINAL_LIVE_BASE),
        ),
        secretKey: required(cfg.TERMINAL_SECRET_KEY, 'TERMINAL_SECRET_KEY', 'terminal', mode),
        connectionToken: required(
          cfg.TERMINAL_CONNECTION_TOKEN,
          'TERMINAL_CONNECTION_TOKEN',
          'terminal',
          mode,
        ),
      };
    default:
      return unsupported('terminal', mode);
  }
}

export interface DeereEndpoints {
  /** Platform API root, e.g. https://sandboxapi.deere.com/platform. */
  apiBase: string;
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
        apiBase:
          mode === 'sandbox'
            ? 'https://sandboxapi.deere.com/platform' // doc-derived, confirm
            : 'https://partnerapi.deere.com/platform', // doc-derived, confirm
        authBase: `https://signin.johndeere.com/oauth2/${DEERE_AUTH_SERVER_ID}`, // doc-derived, confirm
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
