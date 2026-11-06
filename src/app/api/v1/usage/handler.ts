/**
 * POST /api/v1/usage `{ route: '/board' | '/m' }` -> 200 `UsageHeartbeatResponse { recorded }`:
 * the board's heartbeat (decision 2a-11; docs/contracts-2a.md §5.2, §7.7), posted by
 * `UsageHeartbeat` every USAGE_HEARTBEAT_MS while the page is visible.
 *
 * In order: requireRole(ROLE_FOR.viewPrivate) FIRST (any session; 401/403 JSON otherwise); 403
 * for a cross-site request; 415 unless application/json; 413 over USAGE_BODY_MAX_BYTES; 400 for
 * bad JSON or a body the contract's schema refuses. Then a session with no person (appUserId
 * null: an unattended wall, a cab iPad with no one signed in) answers `recorded: false` and
 * writes nothing, so a wall left on all night logs no board time; a person's beat writes one
 * `board_heartbeat` row (`recorded: false` when its 5-minute bucket already had one). A database
 * failure is a logged 503. Every answer is JSON and no-store (limitedJson). Framework-free, so
 * the DB tests call it under runWithSession.
 */
import type { Executor } from '@/db/exec';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { isSameOriginRequest } from '@/platform/http/origin';
import { writeUsage } from '@/platform/usage/record';
import { type UsageHeartbeatResponse, usageHeartbeatBodySchema } from '@/ui/work/contract';

/** A heartbeat body is about 20 bytes; anything near this is not one. */
export const USAGE_BODY_MAX_BYTES = 1024;

const ROUTE = 'api/v1/usage';

function json(status: number, body: unknown): Response {
  return limitedJson(body, { status, headers: { 'cache-control': 'no-store' } }, { route: ROUTE });
}

export async function handleUsageHeartbeat(
  request: Request,
  ex: Executor,
  now: () => Date = () => new Date(),
): Promise<Response> {
  let session: Awaited<ReturnType<typeof requireRole>>;
  try {
    session = await requireRole(ROLE_FOR.viewPrivate);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  if (!isSameOriginRequest(request)) return json(403, { error: 'cross-site request refused' });
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return json(415, { error: 'send the heartbeat as application/json' });
  }
  const text = await readLimitedText(request, USAGE_BODY_MAX_BYTES);
  if (text === null) return json(413, { error: 'request body too large' });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not valid JSON' });
  }
  const parsed = usageHeartbeatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: parsed.error.issues[0]?.message ?? 'bad heartbeat body' });
  }
  if (session.appUserId === null) {
    const body: UsageHeartbeatResponse = { recorded: false };
    return json(200, body);
  }
  try {
    const recorded = await writeUsage(
      {
        kind: 'board_heartbeat',
        route: parsed.data.route,
        appUserId: session.appUserId,
        deviceId: session.deviceId,
      },
      { ex, now: now() },
    );
    const body: UsageHeartbeatResponse = { recorded };
    return json(200, body);
  } catch (e) {
    console.error(`[${ROUTE}]`, (e as Error).message);
    return json(503, { error: 'the heartbeat could not be recorded; it is sent again shortly' });
  }
}
