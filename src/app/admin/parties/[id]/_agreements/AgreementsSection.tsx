/**
 * The data-rights agreements of a customer (D17, decision 2a-10; docs/contracts-2a.md §7.6) on
 * /admin/parties/<id>: list, record (signed on, permitted uses, notes, the signed document
 * through the private `uploads` bucket's two-step grant) and revoke. Shown for customer
 * parties (role customer, either kind: the agreement sits on whichever party a Deere org
 * resolves to). The page has already checked ROLE_FOR.admin; every action checks again.
 *
 * Each agreement's document opens through a signed read URL (valid an hour, private, no-store).
 * The card also says which Deere orgs belong to this customer as the data-rights gate resolves
 * them, and so whether they are read in live. Props frozen (additive changes only). Test ids:
 * `party-agreements`, `agreement-row` (`data-agreement-id`, `data-state` in_force / revoked),
 * `agreement-document-link`, `agreement-revoke`, `agreement-new` and its fields.
 */
import Link from 'next/link';
import { getPool } from '@/db/client';
import { type AgreementRow, deereOrgsOfParty, listAgreements } from '@/db/queries/agreements';
import type { PartyDetail } from '@/db/queries/parties';
import { agreementInForce } from '@/domain/data-rights';
import { farmDate } from '@/domain/farm';
import { PERMITTED_USE_LABELS } from '@/domain/work-jobs';
import { getStorageWriter } from '@/platform/storage/writer';
import { ActionForm, SubmitButton } from '../../../_components/controls';
import adminCss from '../../../admin.module.css';
import css from '../../../fields/field-data.module.css';
import { AgreementForm } from './AgreementForm';
import { revokeAgreementAction } from './actions';

export interface AgreementsSectionProps {
  party: PartyDetail;
}

/** A signed document link lives this long (the page is re-rendered on every visit). */
const DOCUMENT_LINK_SECONDS = 60 * 60;

async function documentUrl(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await getStorageWriter().createSignedReadUrl('uploads', key, DOCUMENT_LINK_SECONDS);
  } catch (e) {
    console.warn('[agreements] no document link:', (e as Error).message);
    return null;
  }
}

function AgreementItem({
  a,
  partyId,
  url,
  today,
}: {
  a: AgreementRow;
  partyId: string;
  url: string | null;
  today: string;
}) {
  const inForce = agreementInForce(a);
  return (
    <li
      className={adminCss.stack}
      data-testid="agreement-row"
      data-agreement-id={a.id}
      data-state={inForce ? 'in_force' : 'revoked'}
    >
      <div className={adminCss.row}>
        <span className={`${adminCss.badge} ${inForce ? adminCss.ok : adminCss.idle}`}>
          {inForce ? 'in force' : `revoked ${a.revokedOn}`}
        </span>
        <strong>signed {a.signedOn}</strong>
        <span className={css.muted}>
          {a.permittedUses.map((u) => PERMITTED_USE_LABELS[u]).join(', ') || 'no uses'}
        </span>
      </div>
      <div className={adminCss.row}>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={css.link}
            data-testid="agreement-document-link"
          >
            Signed document
          </a>
        ) : (
          <span className={css.muted}>
            {a.documentKey ? 'document not readable' : 'no document on file'}
          </span>
        )}
        <span className={css.muted}>
          {a.source === 'demo' ? 'demo agreement' : `recorded by ${a.createdByName ?? 'someone'}`}
        </span>
      </div>
      {a.notes && <p className={css.muted}>{a.notes}</p>}
      {inForce && (
        <ActionForm action={revokeAgreementAction} className={adminCss.row}>
          <input type="hidden" name="id" value={a.id} />
          <input type="hidden" name="partyId" value={partyId} />
          <label className={css.label}>
            Revoked on
            <input
              name="revokedOn"
              type="date"
              required
              min={a.signedOn}
              max={today}
              defaultValue={today}
              className={css.input}
              data-testid="agreement-revoked-on"
            />
          </label>
          <SubmitButton
            className={`${adminCss.button} ${adminCss.danger}`}
            testId="agreement-revoke"
          >
            Revoke
          </SubmitButton>
        </ActionForm>
      )}
    </li>
  );
}

export async function AgreementsSection({ party }: AgreementsSectionProps) {
  if (!party.roles.includes('customer')) return null;
  const pool = getPool();
  const [agreements, orgs] = await Promise.all([
    listAgreements(pool, party.id),
    deereOrgsOfParty(pool, party.id),
  ]);
  const urls = await Promise.all(agreements.map((a) => documentUrl(a.documentKey)));
  const inForce = agreements.some(agreementInForce);
  const today = farmDate(new Date());

  return (
    <section
      className={adminCss.card}
      data-testid="party-agreements"
      data-in-force={inForce ? 'true' : 'false'}
    >
      <h2>Data-rights agreement (D17)</h2>
      <p className={css.muted} data-testid="agreement-orgs">
        {orgs.length === 0 ? (
          <>
            No Deere organization is linked to {party.displayName} yet: link theirs on{' '}
            <Link href="/admin/connectors" className={css.link}>
              Connectors
            </Link>{' '}
            (or it links itself on its first sync).
          </>
        ) : (
          <>
            Deere {orgs.length === 1 ? 'org' : 'orgs'} {orgs.join(', ')}:{' '}
            {inForce
              ? 'read, an agreement is on file.'
              : 'not read once the Deere connection is live (sandbox or live) until an agreement is on file.'}
          </>
        )}
      </p>
      {agreements.length === 0 ? (
        <p className={css.muted}>No agreement on file.</p>
      ) : (
        <ul className={adminCss.events}>
          {agreements.map((a, i) => (
            <AgreementItem
              key={a.id}
              a={a}
              partyId={party.id}
              url={urls[i] ?? null}
              today={today}
            />
          ))}
        </ul>
      )}
      <h3>Record a signed agreement</h3>
      <AgreementForm partyId={party.id} today={today} />
    </section>
  );
}
