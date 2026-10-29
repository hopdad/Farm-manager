/**
 * /admin/fields (plan 1c): your fields, and the ways real data gets in:
 *  - boundaries from an Operations Center shapefile export or GeoJSON (preview, then apply;
 *    the same import as `pnpm import:boundaries`),
 *  - crop history from a CSV (`pnpm import:seasons`; template on this page),
 *  - a field drawn by hand (/admin/fields/new), and hiding the demo farm once yours are in.
 * Each field's own page edits its identity and, for fields not in Operations Center, its
 * boundary (D6). Manager or owner only.
 */
import Link from 'next/link';
import { getPool } from '@/db/client';
import { countDemoFields, listAdminFields } from '@/db/queries/boundaries-fields';
import { ROLE_FOR } from '@/platform/auth/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import adminCss from '../admin.module.css';
import { FileImport } from './_components/FileImport';
import { NoAccess } from './_components/NoAccess';
import { pageAccess } from './_lib/access';
import { SEASONS_TEMPLATE_CSV } from './_lib/templates';
import {
  applyBoundaryImportAction,
  applySeasonImportAction,
  previewBoundaryImportAction,
  previewSeasonImportAction,
  setDemoVisibleAction,
} from './actions';
import css from './field-data.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fields · Farm Ops' };

const TENURE = {
  owned: 'Owned',
  cash_rent: 'Cash rent',
  share: 'Share',
  custom: 'Custom',
} as const;

export default async function FieldsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await pageAccess(ROLE_FOR.admin);
  if (!access.ok) return <NoAccess status={access.status} required={access.required} />;
  const sp = await searchParams;
  const all = sp.all === '1';
  const q = typeof sp.q === 'string' ? sp.q : '';
  const pool = getPool();
  const [fields, demo] = await Promise.all([
    listAdminFields(pool, { includeInactive: all, q }),
    countDemoFields(pool),
  ]);

  return (
    <NoticeProvider>
      <div className={adminCss.pageHead}>
        <h1>Fields</h1>
        <nav className={adminCss.row}>
          <Link
            href="/admin/fields/new"
            className={`${adminCss.button} ${adminCss.primary}`}
            style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
            data-testid="new-field"
          >
            Draw a new field
          </Link>
          <Link href="/admin/parties" className={adminCss.navLink}>
            Landlords, customers, crew
          </Link>
        </nav>
      </div>

      <div className={adminCss.grid}>
        <FileImport
          title="Import boundaries"
          testId="boundary-import"
          accept=".zip,.shp,.dbf,.prj,.cpg,.shx,.geojson,.json"
          multiple
          hint={
            <>
              An Operations Center boundary export (.zip), a .shp with its .dbf and .prj, or
              GeoJSON. Fields are matched by Deere id, else by name and shape; Deere-synced
              boundaries are left alone. Up to 1 MB here; bigger files:{' '}
              <code>pnpm import:boundaries</code>.
            </>
          }
          options={
            <div className={css.formGrid}>
              <label className={css.label}>
                Farm (blank: the file's farm column, else "Home farm")
                <input name="farm" className={css.input} data-testid="boundary-import-farm" />
              </label>
              <label className={css.label}>
                Versions start (blank: now)
                <input name="effective" type="date" className={css.input} />
              </label>
              <label className={css.label}>
                Field name column (blank: detected)
                <input name="nameAttr" className={css.input} placeholder="FIELD_NAME" />
              </label>
              <label className={css.check}>
                <input type="checkbox" name="hideDemo" /> Hide the demo fields afterwards
              </label>
            </div>
          }
          preview={previewBoundaryImportAction}
          apply={applyBoundaryImportAction}
        />
        <FileImport
          title="Import crop history"
          testId="season-import"
          accept=".csv,text/csv"
          hint={
            <>
              One row per field and year: field, crop_year, crop, variety, planted_on, harvested_on,
              yield_bu_ac (add a farm column if two farms share a field name).{' '}
              <a
                className={css.link}
                download="seasons-template.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(SEASONS_TEMPLATE_CSV)}`}
              >
                Download the template
              </a>
              . Same as <code>pnpm import:seasons</code>.
            </>
          }
          options={
            <label className={css.check}>
              <input type="checkbox" name="replaceDeere" /> Replace seasons that came from
              Operations Center
            </label>
          }
          preview={previewSeasonImportAction}
          apply={applySeasonImportAction}
        />
        <section className={adminCss.card} data-testid="demo-card">
          <h2>Demo farm</h2>
          <p className={css.muted}>
            {demo.active} demo field(s) on the map, {demo.hidden} hidden. Hide them once your own
            fields are in; the simulation keeps running on them either way.
          </p>
          <div className={adminCss.row}>
            <ActionForm action={setDemoVisibleAction}>
              <input type="hidden" name="visible" value="false" />
              <SubmitButton className={adminCss.button} testId="demo-hide">
                Hide demo fields
              </SubmitButton>
            </ActionForm>
            <ActionForm action={setDemoVisibleAction}>
              <input type="hidden" name="visible" value="true" />
              <SubmitButton className={adminCss.button} testId="demo-show">
                Show demo fields
              </SubmitButton>
            </ActionForm>
          </div>
          <p className={css.muted}>
            Back up what you entered before <code>pnpm db:reset</code>:{' '}
            <code>pnpm data:export</code>, then <code>pnpm data:import &lt;file&gt;</code>.
          </p>
        </section>
      </div>

      <section className={adminCss.card}>
        <form className={adminCss.row} method="get">
          <input
            name="q"
            defaultValue={q}
            className={css.input}
            style={{ maxWidth: 320 }}
            placeholder="Search fields or farms"
            aria-label="Search fields or farms"
          />
          <label className={css.check}>
            <input type="checkbox" name="all" value="1" defaultChecked={all} /> Include inactive
          </label>
          <button type="submit" className={adminCss.button}>
            Search
          </button>
        </form>
        <div className={adminCss.tableWrap}>
          <table className={adminCss.table} data-testid="fields-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Farm</th>
                <th>Tenure</th>
                <th>Landlord / customer</th>
                <th>Acres</th>
                <th>Boundary</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} data-field={f.name}>
                  <td>
                    <Link className={css.link} href={`/admin/fields/${f.id}`}>
                      {f.name}
                    </Link>
                    {!f.active && (
                      <>
                        {' '}
                        <span className={`${adminCss.badge} ${adminCss.idle}`}>inactive</span>
                      </>
                    )}
                  </td>
                  <td>{f.farmName}</td>
                  <td>{TENURE[f.tenure]}</td>
                  <td>{f.customerName ?? f.landlordName ?? '–'}</td>
                  <td>{f.acres === null ? '–' : f.acres.toFixed(1)}</td>
                  <td>
                    {f.editable ? (
                      <span className={`${adminCss.badge} ${adminCss.ok}`}>
                        {f.boundarySource ?? 'none'}
                      </span>
                    ) : (
                      <span
                        className={`${adminCss.badge} ${adminCss.warn}`}
                        title="Edited in Operations Center (D6)"
                      >
                        Ops Center
                      </span>
                    )}
                    {f.openRequests > 0 && (
                      <>
                        {' '}
                        <span className={`${adminCss.badge} ${adminCss.bad}`}>
                          {f.openRequests} to change
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {fields.length === 0 && <p className={css.muted}>No fields match.</p>}
      </section>
    </NoticeProvider>
  );
}
