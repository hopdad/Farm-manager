'use client';
/**
 * Overview tab (field-panel builder; contract ../tabs.ts, order 10): who owns or rents the
 * field (with phone and email), its notes, the last five seasons, open jobs (a placeholder until
 * the job board, M2) and where the boundary comes from (read-only for Deere fields, D6).
 * Renders from `detail` alone; `null` while the first load is in flight.
 */
import css from '../field-panel.module.css';
import { NotesSection } from '../NotesSection';
import { SeasonsTable } from '../SeasonsTable';
import { type FieldPanelTab, type FieldPanelTabProps, TAB_ORDER } from '../tabs';
import { useNow } from '../useNow';
import { fieldPanelView } from '../view-model';

function Skeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading field details"
      data-testid="field-overview-loading"
    >
      {[60, 85, 40, 90, 70].map((w) => (
        <div key={w} className={css.skeleton} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export function OverviewTab({ fieldId, detail, variant, role, onChanged }: FieldPanelTabProps) {
  const now = useNow(30_000);
  if (!detail) return <Skeleton />;
  const v = fieldPanelView(detail, role, now);
  const p = v.party;
  return (
    <>
      <section className={css.section} data-testid="field-party" data-role={p.role}>
        <h3 className={css.sectionTitle}>{p.role}</h3>
        <div className={`${css.partyName} ${p.missing ? css.empty : ''}`}>{p.name}</div>
        {(p.phone || p.email) && (
          <div className={css.contacts}>
            {p.phone && (
              <a className={css.contact} href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>
                {p.phone}
              </a>
            )}
            {p.email && (
              <a className={css.contact} href={`mailto:${p.email}`}>
                {p.email}
              </a>
            )}
          </div>
        )}
      </section>

      <NotesSection key={fieldId} fieldId={fieldId} notes={v.notes} onChanged={onChanged} />

      <section className={css.section}>
        <h3 className={css.sectionTitle}>Last {detail.seasons.length || 5} seasons</h3>
        <SeasonsTable seasons={v.seasons} variant={variant} />
      </section>

      <section className={css.section} data-testid="field-open-jobs">
        <h3 className={css.sectionTitle}>Open jobs</h3>
        <p className={css.empty}>{v.openJobs}</p>
      </section>

      <section className={css.section} data-testid="field-boundary">
        <h3 className={css.sectionTitle}>Boundary</h3>
        {v.boundary ? (
          <>
            <div>
              <strong>{v.boundary.acres}</strong> · {v.boundary.source} · since {v.boundary.since}
            </div>
            {v.boundary.readOnlyReason && (
              <div className={css.notice}>{v.boundary.readOnlyReason}</div>
            )}
            {v.boundary.openRequests && (
              <div className={`${css.status} ${css.warn}`}>{v.boundary.openRequests}</div>
            )}
          </>
        ) : (
          <p className={css.empty}>No boundary yet.</p>
        )}
      </section>
    </>
  );
}

export const overviewTab: FieldPanelTab = {
  id: 'overview',
  label: 'Overview',
  order: TAB_ORDER.overview,
  Component: OverviewTab,
};
