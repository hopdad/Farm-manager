/**
 * Where the NWS client talks to, per CONNECTOR_WEATHER (plan §5: "Going live changes a base URL
 * and credentials, not code"; NWS needs no credentials, only a User-Agent):
 *
 *   sim      `${VENDOR_SIM_URL}/nws` (the stand-in; default locally, CI and e2e)
 *   replay   the doc-derived fixtures (./replay.ts) through the replay transport
 *   live     https://api.weather.gov. On the PC, in .env.local: CONNECTOR_WEATHER=live,
 *            NWS_USER_AGENT="farm-manager (you@example.com)" (NWS asks for contact info) and
 *            JOBS_DEMO_CADENCE=off (config refuses the demo cadence with a live connector);
 *            then restart pnpm dev / pnpm pilot
 *   sandbox  NWS has no sandbox: the same as live
 *   off      the weather.nws job does nothing
 */
import type { Config } from '../../config';
import { replayBaseUrl } from '../replay';
import type { Mode } from '../types';
import { nwsReplayFetch } from './replay';

/** The real API (https://www.weather.gov/documentation/services-web-api). */
export const NWS_API_BASE = 'https://api.weather.gov';

export interface NwsEndpoint {
  mode: Exclude<Mode, 'off'>;
  baseUrl: string;
  userAgent: string;
  /** Replay mode's transport (never touches the network). */
  fetch?: typeof fetch;
}

export class NwsModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NwsModeError';
  }
}

export function nwsEndpoint(
  mode: Mode,
  cfg: Pick<Config, 'VENDOR_SIM_URL' | 'NWS_USER_AGENT'>,
  opts: { now?: () => Date } = {},
): NwsEndpoint {
  const userAgent = cfg.NWS_USER_AGENT;
  switch (mode) {
    case 'sim':
      return { mode, baseUrl: `${cfg.VENDOR_SIM_URL.replace(/\/+$/, '')}/nws`, userAgent };
    case 'replay':
      return {
        mode,
        baseUrl: replayBaseUrl('nws'),
        userAgent,
        fetch: nwsReplayFetch({ now: opts.now }),
      };
    case 'sandbox':
    case 'live':
      return { mode, baseUrl: NWS_API_BASE, userAgent };
    default:
      throw new NwsModeError(`nws: mode '${mode}' does not poll`);
  }
}
