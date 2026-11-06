/**
 * The job board's person chips (slice 2a, jobs-api; GET /api/v1/crew, docs/contracts-2a.md
 * §5.2): every party of kind person with role crew, by name, with their sign-in when they have
 * one (app role, active). People with no sign-in can still be assigned. e2e principals (crew
 * parties of source e2e) show in e2e databases.
 */

import type { AppRole } from '../../domain/farm';
import { personInitials } from '../../domain/work-jobs';
import type { CrewPerson } from '../../ui/work/contract';
import { type Executor, exec } from '../exec';

export async function crewPeople(ex: Executor): Promise<CrewPerson[]> {
  const r = await exec<{
    party_id: string;
    app_user_id: string | null;
    name: string;
    app_role: AppRole | null;
    active: boolean | null;
  }>(
    ex,
    `select p.id::text as party_id, u.id::text as app_user_id, p.display_name as name,
            u.role as app_role, u.active
       from farm.parties p
       left join farm.app_users u on u.party_id = p.id
      where p.kind = 'person' and 'crew' = any(p.roles)
      order by lower(p.display_name), p.display_name, p.id`,
  );
  return r.rows.map((row) => ({
    partyId: row.party_id,
    appUserId: row.app_user_id,
    name: row.name,
    initials: personInitials(row.name),
    appRole: row.app_role,
    // False only when a sign-in exists and is switched off (no sign-in: still assignable).
    active: row.active ?? true,
  }));
}
