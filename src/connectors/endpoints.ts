/**
 * Base URLs and credentials per connector mode (plan §5: "Going live changes a base URL and
 * credentials, not code"). Sim mode is the live client against `${VENDOR_SIM_URL}/<vendor>`
 * with SIM_CREDENTIALS (src/sim/types.ts); sandbox/live use the vendor and the configured
 * credentials; replay arrives with the recorded/doc-derived fixtures (1a); off never polls.
 */
import type { Config } from '../config';
import { SIM_CREDENTIALS } from '../sim/types';
import { DEERE_AUTH_SERVER_ID } from './deere/schemas';
import type { Mode } from './types';

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
    throw new ConnectorModeError(`${vendor}: replay fixtures arrive in slice 1a (use sim)`);
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
