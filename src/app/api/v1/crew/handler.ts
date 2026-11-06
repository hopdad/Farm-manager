/**
 * GET /api/v1/crew (slice 2a, jobs-api; docs/contracts-2a.md §5.2): the parties of kind person
 * with role crew, by name, with `appUserId`, `initials`, `appRole` (null = no sign-in) and
 * `active` (src/db/queries/crew.ts). requireRole(viewPrivate) first; `no-store`; 503 when the
 * database is down. Framework-free (the DB tests call it under runWithSession).
 */
import type { Executor } from '@/db/exec';
import { crewPeople } from '@/db/queries/crew';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson } from '@/platform/http/limits';
import type { CrewResponse } from '@/ui/work/contract';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(status: number, body: unknown): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route: 'api/v1/crew' });
}

export async function handleCrew(ex: Executor): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.viewPrivate);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  try {
    const body: CrewResponse = { people: await crewPeople(ex) };
    return json(200, body);
  } catch (e) {
    console.error('[api/v1/crew]', (e as Error).message);
    return json(503, { error: 'the crew list is unavailable' });
  }
}
