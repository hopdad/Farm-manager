/**
 * HTTP client for the vendor stand-in's control API at VENDOR_SIM_URL (docs/contracts.md §9),
 * typed with src/sim/types.ts and nothing else from the stand-in (its code is never imported).
 * Server only: /_control/* answers 403 to anything but loopback, so the browser goes through
 * the admin page's server actions, which run on the PC.
 */

import type {
  ClockControlRequest,
  FaultRule,
  FaultsControlRequest,
  FaultsStatus,
  ResetControlRequest,
  ScenarioControlRequest,
  ScenarioStatus,
  SimClockStatus,
  SimStatus,
  SimVendor,
} from '../../../sim/types';
import {
  DEERE_SIM_CONNECTIONS_CONTROL_PATH,
  type DeereSimConnectionsRequest,
  type DeereSimConnectionsStatus,
} from '../../../sim/vendors/deere/connections-control-types';
import {
  SAMSARA_SIM_FAULTS_CONTROL_PATH,
  type SamsaraSimFaultsRequest,
  type SamsaraSimFaultsStatus,
} from '../../../sim/vendors/samsara/control-types';

export class SimControlError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SimControlError';
    this.status = status;
  }
}

export interface SimControlOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function call<T>(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  opts: SimControlOptions,
): Promise<T> {
  const url = `${base.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
      cache: 'no-store',
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new SimControlError(
      `the vendor stand-in is not reachable at ${base} (${err.cause?.code ?? err.name}): is pnpm dev running?`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = String(j.error ?? j.message ?? detail);
    } catch {
      // keep text
    }
    throw new SimControlError(`${method} ${path}: HTTP ${res.status} ${detail}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SimControlError(`${method} ${path}: the stand-in answered non-JSON`);
  }
}

export const getSimStatus = (base: string, o: SimControlOptions = {}) =>
  call<SimStatus>(base, 'GET', '/_control/status', undefined, { timeoutMs: 1_500, ...o });

export const simClock = (base: string, req: ClockControlRequest, o: SimControlOptions = {}) =>
  call<SimClockStatus>(base, 'POST', '/_control/clock', req, o);

export const simScenario = (base: string, req: ScenarioControlRequest, o: SimControlOptions = {}) =>
  call<ScenarioStatus>(base, 'POST', '/_control/scenario', req, o);

export const simFaults = (base: string, req: FaultsControlRequest, o: SimControlOptions = {}) =>
  call<FaultsStatus>(base, 'POST', '/_control/faults', req, o);

export const simReset = (base: string, req: ResetControlRequest, o: SimControlOptions = {}) =>
  call<SimStatus>(base, 'POST', '/_control/reset', req, o);

/** The Deere stand-in's org-approval knob (1f decision 5; connections-control-types.ts). */
export const getSimDeereConnections = (base: string, o: SimControlOptions = {}) =>
  call<DeereSimConnectionsStatus>(base, 'GET', DEERE_SIM_CONNECTIONS_CONTROL_PATH, undefined, {
    timeoutMs: 1_500,
    ...o,
  });

export const simDeereConnections = (
  base: string,
  req: DeereSimConnectionsRequest,
  o: SimControlOptions = {},
) => call<DeereSimConnectionsStatus>(base, 'POST', DEERE_SIM_CONNECTIONS_CONTROL_PATH, req, o);

/** The Samsara stand-in's fault-code knob (fleet-faults; samsara/control-types.ts). */
export const getSimSamsaraFaults = (base: string, o: SimControlOptions = {}) =>
  call<SamsaraSimFaultsStatus>(base, 'GET', SAMSARA_SIM_FAULTS_CONTROL_PATH, undefined, {
    timeoutMs: 1_500,
    ...o,
  });

export const simSamsaraFaults = (
  base: string,
  req: SamsaraSimFaultsRequest,
  o: SimControlOptions = {},
) => call<SamsaraSimFaultsStatus>(base, 'POST', SAMSARA_SIM_FAULTS_CONTROL_PATH, req, o);

// ---------------------------------------------------------------------------------------------
// Fault toggles on /admin/connectors. Each preset is added with a stable id (`admin-<key>`), so
// the toggle can tell whether it is on and remove exactly that rule.
// ---------------------------------------------------------------------------------------------

export interface FaultPreset {
  key: string;
  id: string;
  title: string;
  description: string;
  rule: Omit<FaultRule, 'id'>;
}

/**
 * The presets ("trucks API down" is the M0 demo). The truck presets hit the farm's own trucks'
 * vendor: Samsara by default (D3; 1f.2: every vendor runs at once, so the hired haulers on Motive
 * and Geotab keep reporting while Samsara is down).
 */
export function faultPresets(
  eldVendor: Extract<SimVendor, 'samsara' | 'motive' | 'geotab'> = 'samsara',
): FaultPreset[] {
  const p = (
    key: string,
    title: string,
    description: string,
    rule: Omit<FaultRule, 'id' | 'label'>,
  ): FaultPreset => ({
    key,
    id: `admin-${key}`,
    title,
    description,
    rule: { ...rule, label: title },
  });
  return [
    p('trucks-down', 'trucks API down', `${eldVendor} unreachable: trucks go stale with a badge`, {
      vendor: eldVendor,
      kind: 'outage',
    }),
    p('trucks-slow', 'trucks API slow', `${eldVendor} answers after 3 s`, {
      vendor: eldVendor,
      kind: 'latency',
      latencyMs: 3_000,
    }),
    p('trucks-429', 'trucks rate-limited', `${eldVendor} answers 429, Retry-After 30 s`, {
      vendor: eldVendor,
      kind: 'rate_limit',
      retryAfterSeconds: 30,
    }),
    p('trucks-dup', 'trucks duplicate pages', `${eldVendor} repeats the previous page`, {
      vendor: eldVendor,
      kind: 'duplicate_page',
    }),
    p('deere-down', 'Deere API down', 'Operations Center unreachable', {
      vendor: 'deere',
      kind: 'outage',
    }),
    p('deere-500', 'Deere errors (500)', 'every Deere call fails with HTTP 500', {
      vendor: 'deere',
      kind: 'http_error',
      status: 500,
    }),
    p('deere-token-expired', 'Deere token expired', 'forces the OAuth refresh path', {
      vendor: 'deere',
      kind: 'token_expired',
    }),
    p('deere-token-revoked', 'Deere token revoked', 'access and refresh tokens rejected', {
      vendor: 'deere',
      kind: 'token_revoked',
    }),
    p('internet-down', 'internet down', 'every vendor unreachable', {
      vendor: '*',
      kind: 'outage',
    }),
  ];
}

/** Speed buttons (sim seconds per wall second). */
export const SPEED_PRESETS = [1, 5, 30, 60] as const;
