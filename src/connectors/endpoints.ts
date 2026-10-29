/**
 * Base URLs and credentials per connector mode (plan §5: "Going live changes a base URL and
 * credentials, not code"). Sim mode is the live client against `${VENDOR_SIM_URL}/<vendor>`
 * with SIM_CREDENTIALS (src/sim/types.ts); sandbox/live use the vendor and the configured
 * credentials; replay (contracts-m1 §10) is the live client against `replayBaseUrl(<vendor>)`
 * (https://replay.invalid/<vendor>, never resolvable) with a fixed token, the fixture transport
 * being added by the client (`SamsaraClient.forMode`, `DeereClient.forReplay`); off never polls.
 * Motive has no replay fixtures until D3 picks the ELD vendor.
 */
import type { Config } from '../config';
import { SIM_CREDENTIALS } from '../sim/types';
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
      `${vendor}: no replay fixtures yet (use sim, or ELD_VENDOR=samsara for an ELD replay)`,
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
    case 'sandbox':
    case 'live':
      return {
        baseUrl: 'https://api.gomotive.com', // doc-derived, confirm
        apiKey: required(cfg.MOTIVE_API_KEY, 'MOTIVE_API_KEY', 'motive', mode),
      };
    default:
      return unsupported('motive', mode);
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

/** Sources with replay fixtures (src/connectors/<source>/replay.ts). */
export type ReplaySource = 'deere' | 'samsara';

const REPLAY_FIXTURES: Record<ReplaySource, () => Promise<readonly ReplayFixture[]>> = {
  deere: () => import('./deere/replay').then((m) => m.deereReplayFixtures),
  samsara: () => import('./samsara/replay').then((m) => m.samsaraReplayFixtures),
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
