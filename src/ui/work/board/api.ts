/**
 * The job board's writes and reads over HTTP (framework-free; ./api.test.ts drives it with a
 * fake fetch): the routes of docs/contracts-2a.md §5.2 through the URL helpers and zod schemas
 * of src/ui/work/contract.ts. Same-origin JSON (the browser sends the Origin the routes check);
 * no server actions (status.md: their refreshes delayed results 5-15 s).
 *
 * Every write sends the `version` the screen saw (decision 2a-7) and resolves to a WriteResult,
 * never throws: the board shows the outcome (a 409 carries the CURRENT job, which replaces the
 * screen's copy, and the board says JOB_CONFLICT_MESSAGE).
 */
import type { JobStatus } from '../../../domain/work-jobs';
import {
  type AssignmentPart,
  type BoardSnapshot,
  boardSnapshotSchema,
  CREW_URL,
  type CrewPerson,
  crewResponseSchema,
  JOB_CONFLICT_MESSAGE,
  JOB_RULE_REASONS,
  JOBS_REORDER_URL,
  type JobView,
  jobAssignmentsUrl,
  jobAssignmentUrl,
  jobCancelUrl,
  jobConflictResponseSchema,
  jobFieldUrl,
  jobResponseSchema,
  jobStatusUrl,
  jobsUrl,
  type LngLat,
} from '../contract';

export type JobRuleReason = (typeof JOB_RULE_REASONS)[number];

export type WriteFailure =
  | { ok: false; kind: 'conflict'; job: JobView; message: string }
  | { ok: false; kind: 'rule'; reason: JobRuleReason | null; message: string }
  | { ok: false; kind: 'denied'; message: string }
  | { ok: false; kind: 'not_found'; message: string }
  | { ok: false; kind: 'error'; message: string };

export type WriteResult = { ok: true; job: JobView } | WriteFailure;
export type ReorderResult = { ok: true; snapshot: BoardSnapshot } | WriteFailure;

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'denied' | 'unavailable' | 'error'; status: number | null; message: string };

/** The part of a job a write needs: which one, and the version this screen saw. */
export type JobRef = Pick<JobView, 'id' | 'version'>;

export type SetFieldTarget = { fieldId: string | null } | { at: LngLat };
export type AssignTarget = { machineId: string } | { partyId: string };

export interface BoardApi {
  snapshot(signal?: AbortSignal): Promise<ReadResult<BoardSnapshot>>;
  crew(signal?: AbortSignal): Promise<ReadResult<CrewPerson[]>>;
  setField(job: JobRef, target: SetFieldTarget): Promise<WriteResult>;
  assign(job: JobRef, target: AssignTarget): Promise<WriteResult>;
  unassign(job: JobRef, assignmentId: string, part?: AssignmentPart): Promise<WriteResult>;
  setStatus(job: JobRef, status: JobStatus): Promise<WriteResult>;
  cancel(job: JobRef, reason: string | null): Promise<WriteResult>;
  reorder(
    businessLine: BoardSnapshot['lanes'][number]['businessLine'],
    jobs: JobRef[],
  ): Promise<ReorderResult>;
}

/** Plain words for a refusal the server explains with a reason (422). */
const RULE_MESSAGES: Partial<Record<JobRuleReason, string>> = {
  not_on_field: 'That spot is not on a field',
  machine_retired: 'That machine is retired',
  closed: 'This job is already closed',
};

const NETWORK_MESSAGE = 'No connection to the server; try again';

type Fetch = typeof fetch;

async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

function errorText(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && e.trim() ? e : null;
}

function isRuleReason(v: unknown): v is JobRuleReason {
  return typeof v === 'string' && (JOB_RULE_REASONS as readonly string[]).includes(v);
}

/** Map a write's response to a WriteFailure (anything but a 2xx). */
async function failure(res: Response): Promise<WriteFailure> {
  const body = await readJson(res);
  if (res.status === 409) {
    const parsed = jobConflictResponseSchema.safeParse(body);
    if (parsed.success) {
      return { ok: false, kind: 'conflict', job: parsed.data.job, message: JOB_CONFLICT_MESSAGE };
    }
    return { ok: false, kind: 'error', message: JOB_CONFLICT_MESSAGE };
  }
  if (res.status === 422) {
    const raw = (body as { reason?: unknown } | null)?.reason;
    const reason = isRuleReason(raw) ? raw : null;
    return {
      ok: false,
      kind: 'rule',
      reason,
      message: (reason && RULE_MESSAGES[reason]) ?? errorText(body) ?? 'The server refused it',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      kind: 'denied',
      message:
        res.status === 401
          ? 'Sign in to change jobs'
          : (errorText(body) ?? 'Your sign-in may not change this job'),
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      kind: 'not_found',
      message: errorText(body) ?? 'That job (or what it was dropped on) no longer exists',
    };
  }
  return {
    ok: false,
    kind: 'error',
    message: `The server couldn't save it (${res.status}); try again`,
  };
}

export function createBoardApi(fetchFn: Fetch): BoardApi {
  async function write(url: string, method: string, body?: unknown): Promise<WriteResult> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, kind: 'error', message: NETWORK_MESSAGE };
    }
    if (!res.ok) return failure(res);
    const parsed = jobResponseSchema.safeParse(await readJson(res));
    if (!parsed.success) {
      return { ok: false, kind: 'error', message: 'The server answered something unexpected' };
    }
    return { ok: true, job: parsed.data.job };
  }

  async function read<T>(
    url: string,
    parse: (body: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<ReadResult<T>> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      return { ok: false, kind: 'error', status: null, message: 'no connection' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'denied', status: res.status, message: 'not allowed' };
    }
    if (res.status === 501 || res.status === 404) {
      // The route isn't on this server (the foundation's stubs answer 501 until the merge).
      return {
        ok: false,
        kind: 'unavailable',
        status: res.status,
        message: `the server answered ${res.status}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        kind: 'error',
        status: res.status,
        message: `the server answered ${res.status}`,
      };
    }
    const value = parse(await readJson(res));
    if (value === null) {
      return { ok: false, kind: 'error', status: res.status, message: 'unexpected response' };
    }
    return { ok: true, value };
  }

  return {
    snapshot: (signal) =>
      read(
        jobsUrl(),
        (b) => {
          const p = boardSnapshotSchema.safeParse(b);
          return p.success ? p.data : null;
        },
        signal,
      ),
    crew: (signal) =>
      read(
        CREW_URL,
        (b) => {
          const p = crewResponseSchema.safeParse(b);
          return p.success ? p.data.people : null;
        },
        signal,
      ),
    setField: (job, target) =>
      write(jobFieldUrl(job.id), 'PUT', { version: job.version, ...target }),
    assign: (job, target) =>
      write(jobAssignmentsUrl(job.id), 'POST', { version: job.version, ...target }),
    unassign: (job, assignmentId, part) =>
      write(jobAssignmentUrl(job.id, assignmentId, job.version, part), 'DELETE'),
    setStatus: (job, status) =>
      write(jobStatusUrl(job.id), 'POST', { version: job.version, status }),
    cancel: (job, reason) =>
      write(jobCancelUrl(job.id), 'POST', {
        version: job.version,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      }),
    async reorder(businessLine, jobs) {
      let res: Response;
      try {
        res = await fetchFn(JOBS_REORDER_URL, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            businessLine,
            jobs: jobs.map((j) => ({ id: j.id, version: j.version })),
          }),
        });
      } catch {
        return { ok: false, kind: 'error', message: NETWORK_MESSAGE };
      }
      if (!res.ok) return failure(res);
      const parsed = boardSnapshotSchema.safeParse(await readJson(res));
      if (!parsed.success) {
        return { ok: false, kind: 'error', message: 'The server answered something unexpected' };
      }
      return { ok: true, snapshot: parsed.data };
    },
  };
}
