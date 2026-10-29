/**
 * The browser side of POST /api/machines/<id>/status (framework-free, unit-tested): one call,
 * every failure turned into a sentence a driver can act on.
 */
import {
  type MachineStatusResult,
  machineStatusResultSchema,
  machineStatusUrl,
  type SetMachineStatusBody,
} from './contract';

export type SetStatusOutcome =
  | { ok: true; result: MachineStatusResult }
  | { ok: false; status: number; error: string };

function messageFor(status: number, serverError: string | undefined): string {
  switch (status) {
    case 401:
      return 'Sign in first, then try again.';
    case 403:
      return serverError?.startsWith('cross-site')
        ? 'This page may not change machines.'
        : 'Your role may not mark machines down. Ask a manager.';
    case 404:
      return 'That machine no longer exists.';
    case 409:
      return serverError ?? 'That machine is retired.';
    case 400:
      return serverError ?? 'Check the reason and try again.';
    default:
      return serverError ?? 'Could not save. Check the connection and try again.';
  }
}

export async function postMachineStatus(
  machineId: string,
  body: SetMachineStatusBody,
  doFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): Promise<SetStatusOutcome> {
  let res: Response;
  try {
    res = await doFetch(machineStatusUrl(machineId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: 'No connection to the farm server. Try again.' };
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // not JSON (a proxy error page): handled below
  }
  if (res.ok) {
    const parsed = machineStatusResultSchema.safeParse(payload);
    if (parsed.success) return { ok: true, result: parsed.data };
    return {
      ok: false,
      status: res.status,
      error: 'Saved, but the answer was unexpected. Reload.',
    };
  }
  const serverError =
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : undefined;
  return { ok: false, status: res.status, error: messageFor(res.status, serverError) };
}
