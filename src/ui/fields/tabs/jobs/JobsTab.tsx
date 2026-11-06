'use client';
/**
 * The field panel's Jobs tab (job-forms; docs/contracts-2a.md §7.3): the field's open jobs, each
 * with its status colour (src/ui/work/style.ts), kind, summary, window, who and what is on it,
 * its products and flags; "New job here" for managers opens the job form inline with the field
 * filled in (and Edit on each job). The list comes from GET /api/v1/jobs?fieldId= and stays
 * current through realtime `jobs`/`updated` for this field (./loader.ts). Every write is checked
 * again on the server (planJobs); `role` only hides the buttons.
 */
import { type ReactNode, useState } from 'react';
import { ROLE_FOR, type Role, roleAtLeast } from '../../../../platform/auth/types';
import type { JobView } from '../../../work/contract';
import { JobForm } from '../../../work/forms/JobForm';
import type { FieldPanelTabProps } from '../../tabs';
import css from './jobs-tab.module.css';
import type { FieldJobsState } from './loader';
import { jobRowText, splitJobs } from './row-text';
import { useFieldJobs } from './useFieldJobs';

type Editing = { mode: 'new' } | { mode: 'edit'; job: JobView } | null;

export function JobsTab({ fieldId, variant, role, onChanged }: FieldPanelTabProps) {
  const { state, refetch } = useFieldJobs(fieldId);
  const [editing, setEditing] = useState<Editing>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const done = (job: JobView) => {
    setEditing(null);
    setSaved(job.summary);
    refetch();
    // The Overview's open-jobs count comes with the field's detail.
    onChanged([]);
  };
  return (
    <FieldJobsView
      fieldId={fieldId}
      variant={variant}
      role={role}
      state={state}
      editing={editing}
      saved={saved}
      onNew={() => {
        setSaved(null);
        setEditing({ mode: 'new' });
      }}
      onEdit={(job) => {
        setSaved(null);
        setEditing({ mode: 'edit', job });
      }}
      onRetry={refetch}
      form={
        editing ? (
          <JobForm
            key={editing.mode === 'edit' ? `${editing.job.id}:${editing.job.version}` : 'new'}
            variant={variant}
            job={editing.mode === 'edit' ? editing.job : null}
            initial={{ fieldId }}
            onSaved={done}
            onCancel={() => setEditing(null)}
          />
        ) : null
      }
    />
  );
}

export interface FieldJobsViewProps {
  fieldId: string;
  variant: 'wall' | 'phone';
  role: Role;
  state: FieldJobsState;
  editing: Editing;
  /** The summary of the job just saved (a short confirmation). */
  saved: string | null;
  form: ReactNode;
  onNew(): void;
  onEdit(job: JobView): void;
  onRetry(): void;
}

/** The tab's markup (pure: ./jobs.test.ts renders it to HTML). */
export function FieldJobsView(p: FieldJobsViewProps) {
  const { state } = p;
  const canPlan = roleAtLeast(p.role, ROLE_FOR.planJobs);
  const { open, doneToday } = splitJobs(state.jobs ?? []);
  const editingId = p.editing?.mode === 'edit' ? p.editing.job.id : null;
  return (
    <section
      className={`${css.tab} ${p.variant === 'wall' ? css.wall : ''}`}
      data-testid="field-jobs"
      data-state={state.status}
      aria-busy={state.status === 'loading'}
    >
      <div className={css.toolbar}>
        <h4 className={css.heading}>
          {state.jobs === null
            ? 'Open jobs'
            : `${open.length} open job${open.length === 1 ? '' : 's'}`}
          {doneToday > 0 ? ` · ${doneToday} done today` : ''}
        </h4>
        {canPlan && p.editing?.mode !== 'new' && (
          <button
            type="button"
            className={`${css.button} ${css.primary}`}
            onClick={p.onNew}
            data-testid="field-new-job"
          >
            New job here
          </button>
        )}
      </div>
      {p.saved && (
        <p className={css.saved} role="status" data-testid="field-job-saved">
          Saved: {p.saved}
        </p>
      )}
      {p.editing?.mode === 'new' && <div className={css.formWrap}>{p.form}</div>}
      {state.status === 'loading' && <p className={css.muted}>Loading the field’s jobs…</p>}
      {state.status === 'denied' && <p className={css.muted}>Sign in to see this field’s jobs.</p>}
      {state.status === 'error' && (
        <p className={css.error}>
          Couldn’t load the jobs ({state.error}).{' '}
          <button type="button" className={css.button} onClick={p.onRetry}>
            Try again
          </button>
        </p>
      )}
      {state.status === 'ready' && state.error && (
        <p className={css.error}>Couldn’t refresh ({state.error}); showing what was loaded.</p>
      )}
      {state.jobs !== null && open.length === 0 && (
        <p className={css.muted} data-testid="field-jobs-empty">
          No open jobs on this field.
        </p>
      )}
      {open.length > 0 && (
        <ul className={css.list}>
          {open.map((job) => {
            const t = jobRowText(job);
            return (
              <li
                key={job.id}
                className={css.row}
                data-testid="field-job-row"
                data-job-id={job.id}
                data-status={job.status}
              >
                <span
                  className={css.bar}
                  style={{ background: t.status.fill }}
                  aria-hidden="true"
                />
                <div className={css.main}>
                  <div className={css.head}>
                    <span className={css.glyph} title={t.kind}>
                      {t.glyph}
                    </span>
                    <span className={css.title} data-testid="field-job-title">
                      {t.title}
                    </span>
                    <span
                      className={css.pill}
                      style={{ background: t.status.fill, color: t.status.text }}
                      data-testid="field-job-status"
                    >
                      {t.status.label}
                    </span>
                  </div>
                  <p className={css.line}>
                    {[t.window, t.acres, t.customer].filter(Boolean).join(' · ')}
                  </p>
                  <p className={css.line} data-testid="field-job-who">
                    {t.who || 'No one on it yet'}
                  </p>
                  {t.products && <p className={`${css.line} ${css.muted}`}>{t.products}</p>}
                  {t.flags.length > 0 && (
                    <div className={css.flags}>
                      {t.flags.map((f) => (
                        <span
                          key={f.flag}
                          className={css.flag}
                          data-testid="job-flag"
                          data-flag={f.flag}
                        >
                          {f.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {editingId === job.id && <div className={css.formWrap}>{p.form}</div>}
                </div>
                {canPlan && editingId !== job.id && (
                  <div className={css.side}>
                    <button
                      type="button"
                      className={css.button}
                      onClick={() => p.onEdit(job)}
                      data-testid="field-job-edit"
                    >
                      Edit
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
