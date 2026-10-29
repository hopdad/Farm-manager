/**
 * HTTP client for the NWS stand-in's control API (`/_control/vendor/nws/weather`,
 * src/sim/vendors/nws/control-types.ts): the spray demo's wind slider and weather pattern.
 * Server only: the control API answers loopback callers only, so the browser goes through
 * /admin/spray's server actions, which run on the PC.
 */
import {
  NWS_SIM_WEATHER_CONTROL_PATH,
  type NwsSimWeatherRequest,
  type NwsSimWeatherStatus,
  nwsSimWeatherStatusSchema,
} from '@/sim/vendors/nws/control-types';

export class SimWeatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimWeatherError';
  }
}

async function call(
  base: string,
  body: NwsSimWeatherRequest | undefined,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<NwsSimWeatherStatus> {
  const url = `${base.replace(/\/+$/, '')}${NWS_SIM_WEATHER_CONTROL_PATH}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
      cache: 'no-store',
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new SimWeatherError(
      `the vendor stand-in is not reachable at ${base} (${err.cause?.code ?? err.name}): is pnpm dev running?`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = String((JSON.parse(text) as { error?: unknown }).error ?? detail);
    } catch {
      // keep the text
    }
    throw new SimWeatherError(`NWS stand-in: HTTP ${res.status} ${detail}`);
  }
  const parsed = nwsSimWeatherStatusSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new SimWeatherError('NWS stand-in: unexpected answer');
  return parsed.data;
}

export const getSimWeather = (base: string, opts?: { fetch?: typeof fetch; timeoutMs?: number }) =>
  call(base, undefined, { timeoutMs: 1_500, ...opts });

export const setSimWeather = (
  base: string,
  req: NwsSimWeatherRequest,
  opts?: { fetch?: typeof fetch; timeoutMs?: number },
) => call(base, req, opts);
