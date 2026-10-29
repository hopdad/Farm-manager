/**
 * /admin/parties/<id>: edit one party, link the fields they rent out (landlord) and the farms
 * whose fields are their custom work (customer), see who works for an organization, delete
 * one nothing points at. Manager or owner only.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPool } from '@/db/client';
import { listAdminFields, listFarms } from '@/db/queries/boundaries-fields';
import { getParty, listOrgs } from '@/db/queries/parties';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../../_components/controls';
import adminCss from '../../admin.module.css';
import { NoAccess } from '../../fields/_components/NoAccess';
import { pageAccess } from '../../fields/_lib/access';
import css from '../../fields/field-data.module.css';
import { PartyFields } from '../_components/PartyFields';
import {
  deletePartyAction,
  setClientAction,
  setLandlordAction,
  updatePartyAction,
} from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Party · Farm Ops' };

export default async function PartyPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess(ROLE_FOR.admin);
  if (!access.ok) return <NoAccess status={access.status} required={access.required} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const pool = getPool();
  const party = await getParty(pool, id);
  if (!party) notFound();
  const [orgs, fields, farms] = await Promise.all([
    listOrgs(pool),
    listAdminFields(pool),
    listFarms(pool),
  ]);
  const linkedFieldIds = new Set(party.landlordFields.map((f) => f.fieldId));
  const linkedFarmIds = new Set(party.customerFarms.map((f) => f.farmId));
  const isDemo = party.source === 'demo' || party.source === 'sim';

  return (
    <NoticeProvider>
      <div className={adminCss.pageHead}>
        <h1 data-testid="party-title">{party.displayName}</h1>
        <Link href="/admin/parties" className={adminCss.navLink}>
          Everyone
        </Link>
      </div>
      {isDemo && (
        <div className={css.note}>
          A demo party: edits work, but demo data is not in <code>pnpm data:export</code> and the
          demo seed may put it back.
        </div>
      )}
      <div className={adminCss.grid}>
        <section className={adminCss.card} data-testid="party-edit">
          <h2>Details</h2>
          <ActionForm action={updatePartyAction} className={css.form}>
            <input type="hidden" name="id" value={party.id} />
            <input type="hidden" name="version" value={party.version} />
            <PartyFields party={party} orgs={orgs} prefix="party-edit" />
            <SubmitButton
              className={`${adminCss.button} ${adminCss.primary}`}
              testId="party-edit-save"
            >
              Save
            </SubmitButton>
          </ActionForm>
          {party.appUserRole && (
            <p className={css.muted}>
              Signs in to the app as {party.appUserRole} (managed on /admin/people).
            </p>
          )}
        </section>

        <section className={adminCss.card} data-testid="party-fields">
          <h2>Landlord of</h2>
          {party.landlordFields.length === 0 && <p className={css.muted}>No fields.</p>}
          <ul className={adminCss.events}>
            {party.landlordFields.map((f) => (
              <li key={f.fieldId} className={adminCss.row} data-testid="landlord-field">
                <Link className={css.link} href={`/admin/fields/${f.fieldId}`}>
                  {f.name}
                </Link>
                <span className={css.muted}>
                  {f.farmName}
                  {f.acres === null ? '' : ` · ${f.acres.toFixed(1)} ac`}
                </span>
                <ActionForm action={setLandlordAction}>
                  <input type="hidden" name="fieldId" value={f.fieldId} />
                  <input type="hidden" name="partyId" value={party.id} />
                  <input type="hidden" name="clear" value="true" />
                  <SubmitButton className={adminCss.button}>Unlink</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm action={setLandlordAction} className={adminCss.row}>
            <input type="hidden" name="partyId" value={party.id} />
            <select
              name="fieldId"
              required
              className={adminCss.select}
              data-testid="landlord-add-field"
              defaultValue=""
            >
              <option value="" disabled>
                Add a field…
              </option>
              {fields
                .filter((f) => !linkedFieldIds.has(f.id))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.farmName}){f.landlordName ? ` · now ${f.landlordName}` : ''}
                  </option>
                ))}
            </select>
            <SubmitButton className={adminCss.button} testId="landlord-add">
              Link
            </SubmitButton>
          </ActionForm>
        </section>

        <section className={adminCss.card} data-testid="party-farms">
          <h2>Customer of (custom work)</h2>
          {party.customerFarms.length === 0 && <p className={css.muted}>No farms.</p>}
          <ul className={adminCss.events}>
            {party.customerFarms.map((f) => (
              <li key={f.farmId} className={adminCss.row} data-testid="customer-farm">
                <span>
                  {f.name} <span className={css.muted}>· {f.fieldCount} field(s)</span>
                </span>
                <ActionForm action={setClientAction}>
                  <input type="hidden" name="farmId" value={f.farmId} />
                  <input type="hidden" name="partyId" value={party.id} />
                  <input type="hidden" name="clear" value="true" />
                  <SubmitButton className={adminCss.button}>Unlink</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm action={setClientAction} className={adminCss.row}>
            <input type="hidden" name="partyId" value={party.id} />
            <select
              name="farmId"
              required
              className={adminCss.select}
              data-testid="customer-add-farm"
              defaultValue=""
            >
              <option value="" disabled>
                Link a farm…
              </option>
              {farms
                .filter((f) => !linkedFarmIds.has(f.id))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.fieldCount} fields){f.clientName ? ` · now ${f.clientName}` : ''}
                  </option>
                ))}
            </select>
            <SubmitButton className={adminCss.button} testId="customer-add">
              Link
            </SubmitButton>
          </ActionForm>
          <p className={css.muted}>
            Every field of a linked farm shows this customer in the field panel and on the
            custom-work layer.
          </p>
        </section>

        {party.kind === 'org' && (
          <section className={adminCss.card}>
            <h2>People</h2>
            {party.members.length === 0 && (
              <p className={css.muted}>Nobody listed as working here.</p>
            )}
            <ul className={adminCss.events}>
              {party.members.map((m) => (
                <li key={m.id}>
                  <Link className={css.link} href={`/admin/parties/${m.id}`}>
                    {m.displayName}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={adminCss.card}>
          <h2>Delete</h2>
          <p className={css.muted}>
            Only someone nothing points at (unlink fields and farms first).
          </p>
          <ActionForm action={deletePartyAction}>
            <input type="hidden" name="id" value={party.id} />
            <SubmitButton className={`${adminCss.button} ${adminCss.danger}`} testId="party-delete">
              Delete {party.displayName}
            </SubmitButton>
          </ActionForm>
        </section>
      </div>
    </NoticeProvider>
  );
}
