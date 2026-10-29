/**
 * /admin/parties (plan 1c): landlords, customers, crew and everyone else the farm deals with.
 * Add one with the form, or many with a CSV (preview, then apply; template on the page). A
 * party's page links it to fields (as landlord) and farms (as custom-work customer), which is
 * what the field panel shows. Manager or owner only.
 */
import Link from 'next/link';
import { getPool } from '@/db/client';
import { listOrgs, listParties } from '@/db/queries/parties';
import { PARTY_ROLES, type PartyRole } from '@/domain/farm';
import { ROLE_FOR } from '@/platform/auth/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import adminCss from '../admin.module.css';
import { FileImport } from '../fields/_components/FileImport';
import { NoAccess } from '../fields/_components/NoAccess';
import { pageAccess } from '../fields/_lib/access';
import { PARTIES_TEMPLATE_CSV } from '../fields/_lib/templates';
import css from '../fields/field-data.module.css';
import { PartyFields } from './_components/PartyFields';
import { applyPartyImportAction, createPartyAction, previewPartyImportAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Parties · Farm Ops' };

const FILTERS: { role: PartyRole | null; label: string }[] = [
  { role: null, label: 'Everyone' },
  { role: 'landlord', label: 'Landlords' },
  { role: 'customer', label: 'Customers' },
  { role: 'crew', label: 'Crew' },
  { role: 'elevator', label: 'Elevators' },
  { role: 'vendor', label: 'Vendors' },
  { role: 'neighbor', label: 'Neighbors' },
];

export default async function PartiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await pageAccess(ROLE_FOR.admin);
  if (!access.ok) return <NoAccess status={access.status} required={access.required} />;
  const sp = await searchParams;
  const role =
    typeof sp.role === 'string' && (PARTY_ROLES as readonly string[]).includes(sp.role)
      ? (sp.role as PartyRole)
      : null;
  const q = typeof sp.q === 'string' ? sp.q : '';
  const pool = getPool();
  const [parties, orgs] = await Promise.all([listParties(pool, { role, q }), listOrgs(pool)]);
  const href = (r: PartyRole | null) => {
    const p = new URLSearchParams();
    if (r) p.set('role', r);
    if (q) p.set('q', q);
    const s = p.toString();
    return s ? `/admin/parties?${s}` : '/admin/parties';
  };

  return (
    <NoticeProvider>
      <div className={adminCss.pageHead}>
        <h1>Landlords, customers and crew</h1>
        <Link href="/admin/fields" className={adminCss.navLink}>
          Fields
        </Link>
      </div>

      <div className={adminCss.grid}>
        <section className={adminCss.card} data-testid="party-new">
          <h2>Add someone</h2>
          <ActionForm action={createPartyAction} className={css.form}>
            <PartyFields orgs={orgs} prefix="party-new" />
            <SubmitButton
              className={`${adminCss.button} ${adminCss.primary}`}
              testId="party-new-save"
            >
              Add
            </SubmitButton>
          </ActionForm>
        </section>
        <FileImport
          title="Import from a spreadsheet"
          testId="party-import"
          accept=".csv,text/csv"
          hint={
            <>
              Columns: display_name, kind (person or org), roles (landlord; customer; crew …),
              phone, email, address, notes, org (who a person works for). Rows matching someone
              already here (by name) fill in what is new.{' '}
              <a
                className={css.link}
                download="parties-template.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(PARTIES_TEMPLATE_CSV)}`}
              >
                Download the template
              </a>
            </>
          }
          preview={previewPartyImportAction}
          apply={applyPartyImportAction}
        />
      </div>

      <section className={adminCss.card}>
        <nav className={css.tabs} aria-label="Filter by role">
          {FILTERS.map((f) => (
            <Link
              key={f.label}
              href={href(f.role)}
              className={`${css.tab} ${f.role === role ? css.tabOn : ''}`}
              aria-current={f.role === role ? 'page' : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <form className={adminCss.row} method="get" style={{ marginBottom: 12 }}>
          {role && <input type="hidden" name="role" value={role} />}
          <input
            name="q"
            defaultValue={q}
            className={css.input}
            style={{ maxWidth: 320 }}
            placeholder="Search name, phone, email"
            aria-label="Search parties"
          />
          <button type="submit" className={adminCss.button}>
            Search
          </button>
        </form>
        <div className={adminCss.tableWrap}>
          <table className={adminCss.table} data-testid="parties-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Roles</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Works for</th>
                <th>Linked</th>
              </tr>
            </thead>
            <tbody>
              {parties.map((p) => (
                <tr key={p.id} data-party={p.displayName}>
                  <td>
                    <Link className={css.link} href={`/admin/parties/${p.id}`}>
                      {p.displayName}
                    </Link>
                    {p.kind === 'org' && <span className={css.muted}> · org</span>}
                    {(p.source === 'demo' || p.source === 'sim') && (
                      <>
                        {' '}
                        <span className={`${adminCss.badge} ${adminCss.idle}`}>demo</span>
                      </>
                    )}
                  </td>
                  <td>{p.roles.join(', ') || '–'}</td>
                  <td>{p.phone ?? '–'}</td>
                  <td>{p.email ?? '–'}</td>
                  <td>{p.orgName ?? '–'}</td>
                  <td>
                    {[
                      p.landlordOf ? `${p.landlordOf} field(s)` : '',
                      p.customerOf ? `${p.customerOf} farm(s)` : '',
                    ]
                      .filter(Boolean)
                      .join(', ') || '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {parties.length === 0 && <p className={css.muted}>Nobody here yet.</p>}
      </section>
    </NoticeProvider>
  );
}
