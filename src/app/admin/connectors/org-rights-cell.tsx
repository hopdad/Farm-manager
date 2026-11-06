/**
 * The data-rights cell of one row of /admin/connectors' Deere org table (D17; ./org-rights.ts
 * has the states). A server component: the agreements and org links are read once per request
 * for every listed org (React `cache`), whichever row asks first. An org with no customer party
 * gets the "link to customer" form (./org-rights-actions.ts, manager only, checked on the
 * server). Test ids: `deere-org-rights` (`data-org`, `data-state`), `deere-org-link`,
 * `deere-org-link-party`, `deere-org-link-save`.
 */
import Link from 'next/link';
import { cache } from 'react';
import type { Mode } from '@/connectors/types';
import { getPool } from '@/db/client';
import { ActionForm, SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { loadOrgRights, type OrgRightsState, orgRightsView } from './org-rights';
import { linkDeereOrgAction } from './org-rights-actions';

const snapshotOf = cache((mode: Mode, homeOrgId: string | null, orgIdsKey: string) =>
  loadOrgRights(getPool(), { mode, homeOrgId, orgIds: orgIdsKey ? orgIdsKey.split('\n') : [] }),
);

const BADGE: Record<OrgRightsState, string | undefined> = {
  home: css.idle,
  agreed: css.ok,
  blocked: css.bad,
  reported: css.warn,
};

export async function DeereOrgRights({
  orgId,
  orgIds,
  mode,
  homeOrgId,
}: {
  orgId: string;
  /** Every org of the table (one read serves them all). */
  orgIds: readonly string[];
  mode: Mode;
  homeOrgId: string | null;
}) {
  let snap: Awaited<ReturnType<typeof loadOrgRights>>;
  try {
    snap = await snapshotOf(mode, homeOrgId, orgIds.join('\n'));
  } catch (e) {
    return (
      <span className={css.error} data-testid="deere-org-rights" data-org={orgId}>
        agreements not readable: {(e as Error).message}
      </span>
    );
  }
  const v = snap.views.get(orgId) ?? orgRightsView(orgId, { mode, homeOrgId, party: undefined });
  return (
    <div data-testid="deere-org-rights" data-org={orgId} data-state={v.state}>
      <span className={`${css.badge} ${BADGE[v.state] ?? ''}`}>{v.label}</span>
      {v.party && (
        <div className={css.muted}>
          <Link href={`/admin/parties/${v.party.id}`} data-testid="deere-org-party">
            {v.party.name}
          </Link>
          {v.state === 'blocked' || v.state === 'reported'
            ? ': record the signed agreement on their page'
            : ''}
        </div>
      )}
      {v.canLink &&
        (snap.customers.length === 0 ? (
          <div className={css.muted}>
            No customer yet: add one on <Link href="/admin/parties">Parties</Link>, then link it
            here.
          </div>
        ) : (
          <ActionForm action={linkDeereOrgAction} className={css.row} testId="deere-org-link">
            <input type="hidden" name="orgId" value={orgId} />
            <select
              name="partyId"
              required
              defaultValue=""
              className={css.select}
              data-testid="deere-org-link-party"
              aria-label={`Customer of Deere org ${orgId}`}
            >
              <option value="" disabled>
                Link to customer…
              </option>
              {snap.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.kind === 'person' ? ' (person)' : ''}
                </option>
              ))}
            </select>
            <SubmitButton testId="deere-org-link-save">Link</SubmitButton>
          </ActionForm>
        ))}
    </div>
  );
}
