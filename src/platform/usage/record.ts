/**
 * The usage writer (slice 2a, decision 2a-11; docs/contracts-2a.md §7.7): one app.usage_events
 * row per device + person + kind + route per USAGE_BUCKET_MINUTES, written from server code
 * after the session is known, never from proxy.ts:
 *
 *   /board and /m pages      page_view       (src/app/board/page.tsx, src/app/m/page.tsx)
 *   operator PIN sign-in     pin_sign_in     (signInOperator, src/platform/auth/flows.ts)
 *   each job write           job_action      (jobs-api's handlers, the route as `route`)
 *   the board's heartbeat    board_heartbeat (POST /api/v1/usage, every 5 minutes)
 *   morning mode             morning_run     (2b)
 *
 * The row: farm_day = farmDate(at), actor_key = usageActorKey(deviceId, appUserId), bucket_at =
 * usageBucketStart(at) (src/domain/work-jobs.ts), inserted `on conflict (actor_key, kind, route,
 * bucket_at) do nothing`. A usage write must never break the page or the write it records:
 * `recordUsage` never throws (it logs and returns), and it runs outside the caller's
 * transaction unless `ex` is given.
 *
 * FOUNDATION STUB, owned by the rights-usage builder (src/platform/usage/**): a no-op with the
 * frozen signatures, already called from the pages and the PIN sign-in.
 */
import type { Executor } from '../../db/exec';
import type { UsageKind } from '../../domain/work-jobs';
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

/** The usage input for a session (who is signed in on which device). */
export function usageOf(session: Session, kind: UsageKind, route: string): UsageInput {
  return { kind, route, appUserId: session.appUserId, deviceId: session.deviceId };
}

/** Record one usage event. Never throws. STUB: does nothing yet (rights-usage). */
export async function recordUsage(
  _input: UsageInput,
  _opts: RecordUsageOptions = {},
): Promise<void> {}
