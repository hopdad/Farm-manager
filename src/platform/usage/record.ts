/**
 * The usage writer (slice 2a, decision 2a-11; docs/contracts-2a.md §7.7): one app.usage_events
 * row per device + person + kind + route per USAGE_BUCKET_MINUTES, written from server code
 * after the session is known, never from proxy.ts:
 *
 *   /board and /m pages      page_view       (src/app/board/page.tsx, src/app/m/page.tsx)
 *   operator PIN sign-in     pin_sign_in     (signInOperator, src/platform/auth/flows.ts)
 *   each job write           job_action      (jobs-api's handlers, the route as `route`)
 *   the board's heartbeat    board_heartbeat (POST /api/v1/usage, every 4 minutes; recorded
 *                                            only when the session has a person)
 *   morning mode             morning_run     (2b)
 *
 * The row: farm_day = farmDate(at), actor_key = usageActorKey(deviceId, appUserId), bucket_at =
 * usageBucketStart(at) (src/domain/work-jobs.ts), inserted `on conflict (actor_key, kind, route,
 * bucket_at) do nothing`. A usage write must never break the page or the write it records:
 * `recordUsage` never throws (it logs and returns), and it runs outside the caller's
 * transaction unless `ex` is given. `writeUsage` is the same write for a caller that needs the
 * answer (POST /api/v1/usage: recorded or already in the bucket) and handles failures itself.
 *
 * Owned by the rights-usage builder (src/platform/usage/**). The signatures of `usageOf` and
 * `recordUsage` are frozen (additive changes only).
 */
import { getPool } from '../../db/client';
import type { Executor } from '../../db/exec';
import { insertUsageEvent, type UsageEventRow } from '../../db/queries/usage';
import { farmDate } from '../../domain/farm';
import { isUuid } from '../../domain/ids';
import {
  USAGE_KINDS,
  type UsageKind,
  usageActorKey,
  usageBucketStart,
} from '../../domain/work-jobs';
import type { Session } from '../auth/types';

export interface UsageInput {
  kind: UsageKind;
  /** '/board', '/m', or a job write's route ('/api/v1/jobs/[id]/status'); at most 200 chars. */
  route: string;
  appUserId: string | null;
  deviceId: string | null;
}

export interface RecordUsageOptions {
  /** Default: the app pool (its own statement, outside any transaction). */
  ex?: Executor;
  /** Default: the current time. Tests pass a fixed clock. */
  now?: Date;
}

/** app.usage_events.route's limit (its CHECK). Longer routes are cut, never refused. */
export const MAX_USAGE_ROUTE_CHARS = 200;

/** The usage input for a session (who is signed in on which device). */
export function usageOf(session: Session, kind: UsageKind, route: string): UsageInput {
  return { kind, route, appUserId: session.appUserId, deviceId: session.deviceId };
}

/** Thrown by `usageRow` for an input that can't become a row (a caller's bug, not the data's). */
export class UsageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageInputError';
  }
}

const idOrNull = (id: string | null, what: string): string | null => {
  if (id === null) return null;
  if (!isUuid(id)) throw new UsageInputError(`${what} is not a uuid`);
  return id.toLowerCase();
};

/** The row for an input at `at` (pure): farm day, actor key and bucket as §7.7 defines them. */
export function usageRow(input: UsageInput, at: Date): UsageEventRow {
  if (!(USAGE_KINDS as readonly string[]).includes(input.kind)) {
    throw new UsageInputError(`unknown usage kind '${String(input.kind)}'`);
  }
  if (Number.isNaN(at.getTime())) throw new UsageInputError('invalid time');
  const appUserId = idOrNull(input.appUserId, 'appUserId');
  const deviceId = idOrNull(input.deviceId, 'deviceId');
  return {
    at,
    farmDay: farmDate(at),
    kind: input.kind,
    route: (input.route ?? '').slice(0, MAX_USAGE_ROUTE_CHARS),
    appUserId,
    deviceId,
    actorKey: usageActorKey(deviceId, appUserId),
    bucketAt: usageBucketStart(at),
  };
}

/**
 * Write one usage event: true when written, false when its bucket already had it. Throws on a
 * bad input or a database failure (the caller decides what that means).
 */
export async function writeUsage(
  input: UsageInput,
  opts: RecordUsageOptions = {},
): Promise<boolean> {
  const row = usageRow(input, opts.now ?? new Date());
  return insertUsageEvent(opts.ex ?? getPool(), row);
}

/** Record one usage event. Never throws: a failure is logged and the caller goes on. */
export async function recordUsage(input: UsageInput, opts: RecordUsageOptions = {}): Promise<void> {
  try {
    await writeUsage(input, opts);
  } catch (e) {
    console.warn(
      `[usage] ${String(input?.kind)} ${String(input?.route)} not recorded:`,
      (e as Error)?.message ?? e,
    );
  }
}
