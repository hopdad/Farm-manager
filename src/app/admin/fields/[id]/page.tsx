/**
 * /admin/fields/<id> (plan 1c): one field's identity, boundary and history.
 *  - Identity: name (read-only for Deere fields), farm, tenure, landlord, county, active.
 *  - Boundary: the map editor (edit points, redraw, split, merge) for fields not in Operations
 *    Center; for a Deere field (D6) the boundary is read-only, with a "change this in Ops
 *    Center" note, the requests waiting, and a way to add one.
 *  - Boundary versions and the History tab (seasons through splits and merges).
 * Manager or owner only.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPool } from '@/db/client';
import {
  listBoundaryVersions,
  listChangeRequests,
  loadFieldBoundary,
} from '@/db/queries/boundaries';
import { getAdminField, listFarms } from '@/db/queries/boundaries-fields';
import { adjacentFields } from '@/db/queries/lineage';
import { listParties } from '@/db/queries/parties';
import { fieldHistory } from '@/db/queries/seasons';
import { FIELD_PANEL_SEASONS, type FieldDetail } from '@/domain/fields';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { localParts } from '@/sim/time';
import { loadMapPageData } from '@/ui/map/server/map-data';
import { ActionForm, NoticeProvider, SubmitButton } from '../../_components/controls';
import adminCss from '../../admin.module.css';
import { detroitTime } from '../../format';
import { EditorLoader } from '../_components/EditorLoader';
import { HistoryCard } from '../_components/HistoryCard';
import { NoAccess } from '../_components/NoAccess';
import { pageAccess } from '../_lib/access';
import { requestChangeAction, resolveRequestAction, saveIdentityAction } from '../actions';
import css from '../field-data.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Field · Farm Ops' };

const TENURES = [
  ['owned', 'Owned'],
  ['cash_rent', 'Cash rent'],
  ['share', 'Share'],
  ['custom', 'Custom work'],
  // A field the Deere sync created (1f) until someone picks one of the above.
  ['unknown', 'Not set'],
] as const;

const pad = (n: number) => String(n).padStart(2, '0');

const versionTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Detroit',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const when = (iso: string) => versionTime.format(new Date(iso));

export default async function FieldAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess(ROLE_FOR.admin);
  if (!access.ok) return <NoAccess status={access.status} required={access.required} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const pool = getPool();
  const field = await getAdminField(pool, id);
  if (!field) notFound();
  const [boundary, versions, requests, adjacent, farms, parties, history, mapData] =
    await Promise.all([
      loadFieldBoundary(pool, id),
      listBoundaryVersions(pool, id),
      listChangeRequests(pool, id, { includeResolved: true }),
      adjacentFields(pool, id),
      listFarms(pool),
      listParties(pool),
      fieldHistory(pool, id),
      loadMapPageData(),
    ]);
  const p = localParts(Date.now());
  const today = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const landlords = parties.filter(
    (x) => x.roles.includes('landlord') || x.id === field.landlordId,
  );
  const landlord = parties.find((x) => x.id === field.landlordId) ?? null;
  const openRequests = requests.filter((r) => !r.resolvedAt);

  // The History tab renders from a FieldDetail (the field panel's contract); this page has
  // what the tab reads.
  const detail: FieldDetail = {
    field: {
      id: field.id,
      name: field.name,
      farmId: field.farmId,
      farmName: field.farmName,
      tenure: field.tenure,
      acres: field.acres,
      countyFips: field.countyFips,
      landlord: landlord
        ? {
            id: landlord.id,
            displayName: landlord.displayName,
            kind: landlord.kind,
            phone: landlord.phone,
            email: landlord.email,
          }
        : null,
      customer: null,
      deereFieldId: field.deereFieldId,
      active: field.active,
    },
    boundary: null,
    seasons: (history?.seasons ?? []).slice(0, FIELD_PANEL_SEASONS),
    soils: [],
    soilsSummary: null,
    parcels: [],
    openJobs: { count: 0, placeholder: true },
    notes: { text: null, updatedAt: null, updatedByName: null, version: field.version },
    lineage: {
      parents: (history?.ancestors ?? [])
        .filter((a) => a.depth === 1)
        .map((a) => ({
          fieldId: a.fieldId,
          name: a.name,
          kind: a.kind,
          effectiveOn: a.effectiveOn,
        })),
      children: history?.children ?? [],
    },
    openBoundaryRequests: openRequests.length,
    spray: null,
  };

  return (
    <NoticeProvider>
      <div className={adminCss.pageHead}>
        <h1 data-testid="field-title">
          {field.name}{' '}
          {!field.active && <span className={`${adminCss.badge} ${adminCss.idle}`}>inactive</span>}{' '}
          {!field.editable && (
            <span className={`${adminCss.badge} ${adminCss.warn}`}>Ops Center</span>
          )}
        </h1>
        <nav className={adminCss.row}>
          <Link href="/admin/fields" className={adminCss.navLink}>
            All fields
          </Link>
          <Link href="/admin/parties" className={adminCss.navLink}>
            Parties
          </Link>
        </nav>
      </div>

      {!field.editable && (
        <div className={css.note} data-testid="ops-center-note">
          <strong>Change this in Ops Center.</strong> {boundary?.readOnlyReason} Use "Propose a
          change" on the map to keep a note (and a drawing) of what to change; mark it done once
          Operations Center has it.
        </div>
      )}

      <EditorLoader
        data={mapData}
        field={{
          id: field.id,
          name: field.name,
          active: field.active,
          editable: field.editable,
          readOnlyReason: boundary?.readOnlyReason ?? null,
          boundaryId: boundary?.boundaryId ?? null,
          geometry: boundary?.geometry ?? null,
        }}
        adjacent={adjacent}
        today={today}
        farms={[]}
        landlords={[]}
      />

      <div className={adminCss.grid} style={{ marginTop: 16 }}>
        <section className={adminCss.card} data-testid="identity-card">
          <h2>Field</h2>
          <ActionForm action={saveIdentityAction} className={css.form}>
            <input type="hidden" name="fieldId" value={field.id} />
            <input type="hidden" name="version" value={field.version} />
            <label className={css.label}>
              Name {!field.editable && '(as in Operations Center)'}
              <input
                name="name"
                defaultValue={field.name}
                readOnly={!field.editable}
                className={css.input}
                data-testid="identity-name"
              />
            </label>
            <label className={css.label}>
              Farm
              <select name="farmId" defaultValue={field.farmId} className={adminCss.select}>
                {farms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.clientName ? ` (${f.clientName})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.label}>
              Tenure
              <select name="tenure" defaultValue={field.tenure} className={adminCss.select}>
                {TENURES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.label}>
              Landlord
              <select
                name="landlordPartyId"
                defaultValue={field.landlordId ?? ''}
                className={adminCss.select}
                data-testid="identity-landlord"
              >
                <option value="">None</option>
                {landlords.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.label}>
              County (26091 Lenawee, 26115 Monroe)
              <input
                name="countyFips"
                defaultValue={field.countyFips ?? ''}
                className={css.input}
                inputMode="numeric"
              />
            </label>
            <label className={css.check}>
              <input type="checkbox" name="active" defaultChecked={field.active} /> Active (on the
              map)
            </label>
            <SubmitButton
              className={`${adminCss.button} ${adminCss.primary}`}
              testId="identity-save"
            >
              Save
            </SubmitButton>
          </ActionForm>
          <p className={css.muted}>
            Customer: {field.customerName ?? 'your own operation'} (set on the farm, from{' '}
            <Link className={css.link} href="/admin/parties?role=customer">
              Parties
            </Link>
            ). {field.acres === null ? 'No boundary yet.' : `${field.acres.toFixed(1)} ac.`}
          </p>
        </section>

        {(!field.editable || requests.length > 0) && (
          <section className={adminCss.card} data-testid="requests-card">
            <h2>Ops Center changes</h2>
            {openRequests.length === 0 && <p className={css.muted}>Nothing waiting.</p>}
            <ul className={adminCss.events}>
              {requests.map((r) => (
                <li key={r.id} data-testid="change-request" data-open={!r.resolvedAt}>
                  <div>
                    {r.note}
                    {r.hasDrawing ? ' (with a drawing)' : ''}
                  </div>
                  <div className={css.muted}>
                    {detroitTime(r.requestedAt)}
                    {r.requestedByName ? ` by ${r.requestedByName}` : ''}
                    {r.resolvedAt ? ` · done ${detroitTime(r.resolvedAt)}: ${r.resolution}` : ''}
                  </div>
                  {!r.resolvedAt && (
                    <ActionForm action={resolveRequestAction} className={adminCss.row}>
                      <input type="hidden" name="fieldId" value={field.id} />
                      <input type="hidden" name="requestId" value={r.id} />
                      <input
                        name="resolution"
                        placeholder="What was done (optional)"
                        className={css.input}
                        style={{ maxWidth: 260 }}
                      />
                      <SubmitButton className={adminCss.button}>Mark done</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
            <h3>Note a change</h3>
            <ActionForm action={requestChangeAction} className={css.form}>
              <input type="hidden" name="fieldId" value={field.id} />
              <textarea
                name="note"
                required
                className={css.textarea}
                placeholder="e.g. the waterway on the east side moved 30 ft"
                data-testid="request-note"
              />
              <SubmitButton className={adminCss.button} testId="request-save">
                Add to the list
              </SubmitButton>
            </ActionForm>
          </section>
        )}

        <section className={adminCss.card} data-testid="versions-card">
          <h2>Boundary versions</h2>
          {versions.length === 0 && <p className={css.muted}>No boundary yet.</p>}
          <div className={adminCss.tableWrap}>
            <table className={adminCss.table}>
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Acres</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>{v.from ? when(v.from) : '–'}</td>
                    <td>{v.to ? when(v.to) : 'current'}</td>
                    <td>{v.acres.toFixed(1)}</td>
                    <td title={v.sourceRef ?? undefined}>{v.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className={adminCss.card} style={{ marginTop: 16 }} data-testid="history-card">
        <h2>History</h2>
        <HistoryCard fieldId={field.id} detail={detail} role={access.session.role} />
      </section>
    </NoticeProvider>
  );
}
