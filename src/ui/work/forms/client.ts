/**
 * The job form's calls (framework-free; ./client.test.ts drives them with a fake fetch):
 * GET /api/v1/job-options (what the form picks from), POST /api/v1/jobs (a new job) and
 * PATCH /api/v1/jobs/<id> (an edit with the version it saw; docs/contracts-2a.md §5).
 *
 * Every answer is checked against the contract's schemas before the form trusts it. A 409 hands
 * back the CURRENT job (JobConflictResponse, §5.4); a 422 or 400 the server's reason, in words.
 */
import {
  JOB_CONFLICT_MESSAGE,
  JOB_OPTIONS_URL,
  type JobOptionsResponse,
  type JobView,
  jobConflictResponseSchema,
  jobOptionsResponseSchema,
  jobResponseSchema,
  jobsUrl,
  jobUrl,
} from '../contract';
import type { FormMode } from './form-model';

type Fetch = typeof fetch;

export type OptionsResult =
  | { ok: true; options: JobOptionsResponse }
  | { ok: false; status: number | null; message: string };

/** The options of the last good load (an instant form on re-open; always revalidated). */
let cached: JobOptionsResponse | null = null;
export const cachedJobOptions = () => cached;
/** Tests only. */
export function clearJobOptionsCache(): void {
  cached = null;
}

export async function loadJobOptions(fetchFn: Fetch, signal?: AbortSignal): Promise<OptionsResult> {
  let res: Response;
  try {
    res = await fetchFn(JOB_OPTIONS_URL, {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, status: null, message: 'No connection to the farm server.' };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        res.status === 401 || res.status === 403
          ? 'Sign in again to plan jobs.'
          : `The server answered ${res.status}.`,
    };
  }
  const parsed = jobOptionsResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, status: res.status, message: 'Unexpected answer.' };
  cached = parsed.data;
  return { ok: true, options: parsed.data };
}

export type SaveResult =
  | { kind: 'saved'; job: JobView }
  /** 409: someone saved since; `job` is the current one (nothing was written). */
  | { kind: 'conflict'; job: JobView; message: string }
  | { kind: 'error'; status: number | null; message: string };

const errorText = async (res: Response): Promise<string | null> => {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : null;
};

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const up = t[0]?.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/** Save the form: POST for a new job, PATCH (the body carries the version) for an edit. */
export async function saveJob(
  fetchFn: Fetch,
  mode: FormMode,
  body: unknown,
  jobId?: string,
): Promise<SaveResult> {
  if (mode === 'edit' && !jobId) throw new Error('an edit needs the job id');
  let res: Response;
  try {
    res = await fetchFn(mode === 'new' ? jobsUrl() : jobUrl(jobId as string), {
      method: mode === 'new' ? 'POST' : 'PATCH',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: 'error',
      status: null,
      message: 'No connection to the farm server: nothing was saved. Try again.',
    };
  }
  if (res.ok) {
    const parsed = jobResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) return { kind: 'saved', job: parsed.data.job };
    return {
      kind: 'error',
      status: res.status,
      message: 'Saved, but the answer was unexpected: reopen the job to check it.',
    };
  }
  if (res.status === 409) {
    const parsed = jobConflictResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      return { kind: 'conflict', job: parsed.data.job, message: JOB_CONFLICT_MESSAGE };
    }
    return { kind: 'error', status: 409, message: JOB_CONFLICT_MESSAGE };
  }
  const why = await errorText(res);
  const message =
    res.status === 401
      ? 'Sign in again: nothing was saved.'
      : res.status === 403
        ? 'Only a manager can plan jobs: nothing was saved.'
        : res.status === 404
          ? sentence(why ?? 'That job, field, customer or product is gone')
          : res.status === 400 || res.status === 422 || res.status === 413
            ? sentence(why ?? 'The server refused it')
            : `The server answered ${res.status}: nothing was saved. Try again.`;
  return { kind: 'error', status: res.status, message };
}
