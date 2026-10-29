/** The inputs of the add and edit party forms (server-rendered; the form posts to an action). */

import type { PartyDetail } from '@/db/queries/parties';
import { PARTY_ROLES } from '@/domain/farm';
import adminCss from '../../admin.module.css';
import css from '../../fields/field-data.module.css';

const ROLE_LABELS: Record<string, string> = {
  landlord: 'Landlord',
  customer: 'Customer (custom work)',
  crew: 'Crew',
  owner: 'Owner (your operation)',
  elevator: 'Elevator',
  vendor: 'Vendor',
  neighbor: 'Neighbor',
};

export function PartyFields({
  party,
  orgs,
  prefix,
}: {
  party?: PartyDetail | null;
  orgs: { id: string; displayName: string }[];
  /** Test id prefix ('party-new', 'party-edit'). */
  prefix: string;
}) {
  return (
    <>
      <div className={css.formGrid}>
        <label className={css.label}>
          Name
          <input
            name="displayName"
            required
            defaultValue={party?.displayName ?? ''}
            className={css.input}
            data-testid={`${prefix}-name`}
          />
        </label>
        <label className={css.label}>
          Kind
          <select
            name="kind"
            defaultValue={party?.kind ?? 'person'}
            className={adminCss.select}
            data-testid={`${prefix}-kind`}
          >
            <option value="person">Person</option>
            <option value="org">Organization</option>
          </select>
        </label>
        <label className={css.label}>
          Phone
          <input
            name="phone"
            type="tel"
            defaultValue={party?.phone ?? ''}
            className={css.input}
            data-testid={`${prefix}-phone`}
          />
        </label>
        <label className={css.label}>
          Email
          <input
            name="email"
            type="email"
            defaultValue={party?.email ?? ''}
            className={css.input}
          />
        </label>
        <label className={css.label}>
          Works for (people)
          <select name="orgId" defaultValue={party?.orgId ?? ''} className={adminCss.select}>
            <option value="">–</option>
            {orgs
              .filter((o) => o.id !== party?.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
          </select>
        </label>
        <label className={css.label}>
          Address
          <input name="address" defaultValue={party?.address ?? ''} className={css.input} />
        </label>
      </div>
      <fieldset className={css.checks} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={css.muted} style={{ marginBottom: 6 }}>
          Roles
        </legend>
        {PARTY_ROLES.map((r) => (
          <label key={r} className={css.check}>
            <input
              type="checkbox"
              name="roles"
              value={r}
              defaultChecked={party?.roles.includes(r) ?? false}
              data-testid={`${prefix}-role-${r}`}
            />
            {ROLE_LABELS[r] ?? r}
          </label>
        ))}
      </fieldset>
      <label className={css.label}>
        Notes
        <textarea name="notes" defaultValue={party?.notes ?? ''} className={css.textarea} />
      </label>
    </>
  );
}
