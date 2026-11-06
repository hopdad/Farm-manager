'use client';
/**
 * The job detail (docs/contracts-2a.md §7.1, test ids §7.5): on the wall a popover near the
 * band, on phones the jobs sheet's detail view. What the job is (field, customer, window, acres,
 * products, who asked, notes), who and what is on it (with "also on" for double bookings), its
 * flags, and the viewer's actions:
 *
 *  - the status buttons from nextJobStatuses (decision 2a-2/2a-3; implemented in
 *    src/domain/work-jobs.ts): a manager's moves, a driver's on their OWN job only, nothing for
 *    viewers; `cancelled` is the Cancel button (a confirm with an optional reason, posted to
 *    …/cancel);
 *  - for planners: Move up / Move down (POST /api/v1/jobs/reorder with the lane's open jobs in
 *    the new order; the card swaps with its same-priority neighbour, disabled at the edge of its
 *    priority) and Edit (job-forms' JobForm, src/ui/work/forms/JobForm.tsx);
 *  - a 409 says JOB_CONFLICT_MESSAGE here (the card already shows the current job).
 */
import { type ReactNode, useState } from 'react';
import {
  ASSIGNMENT_ROLE_LABELS,
  JOB_PRIORITY_LABELS,
  type JobPriority,
  RATE_UNIT_LABELS,
  REQUEST_CHANNEL_LABELS,
  SUPPLIED_BY_LABELS,
} from '../../../domain/work-jobs';
import type { MapVariant } from '../../map/types';
import type { JobView } from '../contract';
import { JobForm } from '../forms/JobForm';
import { JOB_KIND_GLYPHS, kindLabel, statusLook } from '../style';
import { useBoard, useBoardStoreApi } from './context';
import {
  acresText,
  assignmentLabel,
  type BoardViewer,
  canPlan,
  FLAG_LABELS,
  formatWindow,
  laneOf,
  moveOptions,
  showDeereBadge,
  statusActionLabel,
  statusActions,
  WARNING_FLAGS,
} from './model';
import { NoticeBar } from './NoticeBar';
import { useClock } from './useClock';
import css from './work-board.module.css';

export interface JobDetailProps {
  job: JobView;
  variant: MapVariant;
  viewer: BoardViewer;
  mode: 'view' | 'edit';
  onMode(mode: 'view' | 'edit'): void;
  /** The job left the board (cancelled): close the detail. */
  onGone(): void;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={css.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function priceRate(p: JobView['products'][number]): string {
  const rate =
    p.rate === null
      ? null
      : `${p.rate.toLocaleString('en-US', { maximumFractionDigits: 4 })}${
          p.unit ? ` ${RATE_UNIT_LABELS[p.unit]}` : ''
        }`;
  return [rate, SUPPLIED_BY_LABELS[p.suppliedBy]].filter(Boolean).join(' · ');
}

export function JobFacts({ job }: { job: JobView }) {
  const now = useClock();
  const window = formatWindow(job.window, new Date(now));
  const acres = acresText(job);
  return (
    <dl className={css.facts}>
      <Fact label="Priority">{JOB_PRIORITY_LABELS[job.priority as JobPriority]}</Fact>
      <Fact label="Field">
        {job.field
          ? [job.field.name, job.field.farmName].filter(Boolean).join(' · ')
          : 'No field yet'}
      </Fact>
      {acres && <Fact label="Planned">{acres}</Fact>}
      <Fact label="Window">{window ?? 'No window set'}</Fact>
      {job.customer && <Fact label="Customer">{job.customer.name}</Fact>}
      {job.cropYear !== null && <Fact label="Crop year">{job.cropYear}</Fact>}
      {job.request && (
        <Fact label="Asked for">
          {[
            REQUEST_CHANNEL_LABELS[job.request.channel],
            job.request.name,
            job.request.phone,
            job.request.viaLink ? 'through a request link' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Fact>
      )}
      {job.products.length > 0 && (
        <Fact label="Products">
          <ul className={css.plainList}>
            {job.products.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong>
                {p.restrictedUse && <span className={`${css.flag} ${css.flagWarn}`}>RUP</span>}{' '}
                <span className={css.muted}>{priceRate(p)}</span>
              </li>
            ))}
          </ul>
        </Fact>
      )}
      {job.notes && <Fact label="Notes">{job.notes}</Fact>}
      {job.cancelledReason && <Fact label="Why cancelled">{job.cancelledReason}</Fact>}
    </dl>
  );
}

function Assignments({ job }: { job: JobView }) {
  if (job.assignments.length === 0) {
    return <p className={css.muted}>No one is on this job yet: drag the card onto a chip.</p>;
  }
  return (
    <ul className={css.detailAssignments}>
      {job.assignments.map((a) => (
        <li key={a.id} data-testid="job-detail-assignment" data-assignment-id={a.id}>
          <strong>{assignmentLabel(a)}</strong>{' '}
          <span className={css.muted}>{ASSIGNMENT_ROLE_LABELS[a.role]}</span>
          {a.machine?.status === 'down' && <span className={css.downTag}>down</span>}
          {showDeereBadge(job, a) && <span className={css.deere}>Deere</span>}
          {a.alsoOn.length > 0 && (
            <div className={css.alsoOn} data-testid="job-also-on">
              Also on {a.alsoOn.map((o) => o.summary).join(', ')}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function CancelControl({ job, onGone }: { job: JobView; onGone(): void }) {
  const store = useBoardStoreApi();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const saving = useBoard((s) => (s.pending[job.id] ?? 0) > 0);
  if (!confirming) {
    return (
      <button
        type="button"
        className={`${css.action} ${css.actionDanger}`}
        data-testid="job-cancel"
        disabled={saving}
        onClick={() => setConfirming(true)}
      >
        Cancel job
      </button>
    );
  }
  return (
    <div className={css.cancelBox} data-testid="job-cancel-box">
      <label className={css.cancelLabel}>
        Why (optional)
        <input
          className={css.input}
          data-testid="job-cancel-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className={css.actions}>
        <button
          type="button"
          className={`${css.action} ${css.actionDanger}`}
          data-testid="job-cancel-confirm"
          disabled={saving}
          onClick={async () => {
            const r = await store.getState().cancel(job.id, reason);
            if (r?.ok) onGone();
            else setConfirming(false);
          }}
        >
          Yes, cancel it
        </button>
        <button
          type="button"
          className={css.action}
          data-testid="job-cancel-keep"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

function MoveControls({ job }: { job: JobView }) {
  const store = useBoardStoreApi();
  const lane = useBoard((s) => laneOf(s.snapshot, job.businessLine));
  const saving = useBoard((s) => (s.pending[job.id] ?? 0) > 0);
  const opts = moveOptions(lane, job.id);
  return (
    <div className={css.moveBox}>
      <div className={css.actions}>
        <button
          type="button"
          className={css.action}
          data-testid="job-move-up"
          disabled={!opts.up || saving}
          onClick={() => void store.getState().move(job.id, 'up')}
        >
          Move up
        </button>
        <button
          type="button"
          className={css.action}
          data-testid="job-move-down"
          disabled={!opts.down || saving}
          onClick={() => void store.getState().move(job.id, 'down')}
        >
          Move down
        </button>
      </div>
      {opts.hint && (
        <p className={css.hint} data-testid="job-move-hint">
          {opts.hint}
        </p>
      )}
    </div>
  );
}

export function JobDetail({ job, variant, viewer, mode, onMode, onGone }: JobDetailProps) {
  const store = useBoardStoreApi();
  const saving = useBoard((s) => (s.pending[job.id] ?? 0) > 0);
  const planner = canPlan(viewer);
  const actions = statusActions(job, viewer);
  const look = statusLook(job.status);

  if (mode === 'edit' && planner) {
    return (
      <div
        className={css.detailForm}
        data-testid="job-detail"
        data-job-id={job.id}
        data-mode="edit"
      >
        <JobForm
          variant={variant}
          job={job}
          onSaved={(saved) => {
            store.getState().jobSaved(saved);
            onMode('view');
          }}
          onCancel={() => onMode('view')}
        />
      </div>
    );
  }

  return (
    <div className={css.detail} data-testid="job-detail" data-job-id={job.id} data-mode="view">
      <div className={css.detailHead}>
        <span className={css.glyph} title={kindLabel(job.kind)}>
          {JOB_KIND_GLYPHS[job.kind]}
        </span>
        <h3 className={css.detailTitle}>{job.summary}</h3>
        <span
          className={css.statusTag}
          style={{ background: look.fill, color: look.text }}
          data-testid="job-detail-status"
          data-status={job.status}
        >
          {look.label}
        </span>
      </div>
      <NoticeBar placement="detail" jobId={job.id} />
      {job.flags.length > 0 && (
        <div className={css.cardLine}>
          {job.flags.map((f) => (
            <span
              key={f}
              className={`${css.flag} ${WARNING_FLAGS.has(f) ? css.flagWarn : ''}`}
              data-flag={f}
            >
              {FLAG_LABELS[f]}
            </span>
          ))}
        </div>
      )}
      <JobFacts job={job} />
      <h4 className={css.subhead}>On this job</h4>
      <Assignments job={job} />
      {(actions.statuses.length > 0 || actions.canCancel) && (
        <div className={css.actions} data-testid="job-status-actions">
          {actions.statuses.map((s) => (
            <button
              key={s}
              type="button"
              className={`${css.action} ${css.actionPrimary}`}
              data-testid={`job-status-${s}`}
              disabled={saving}
              onClick={() => void store.getState().setStatus(job.id, s)}
            >
              {statusActionLabel(job.status, s)}
            </button>
          ))}
          {actions.canCancel && <CancelControl job={job} onGone={onGone} />}
        </div>
      )}
      {planner && (
        <>
          <MoveControls job={job} />
          <div className={css.actions}>
            <button
              type="button"
              className={css.action}
              data-testid="job-edit"
              onClick={() => onMode('edit')}
            >
              Edit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The new-job form (a planner's "New job"). */
export function NewJob({
  variant,
  onSaved,
  onCancel,
}: {
  variant: MapVariant;
  onSaved(job: JobView): void;
  onCancel(): void;
}) {
  const store = useBoardStoreApi();
  return (
    <div className={css.detailForm} data-testid="job-detail-new">
      <JobForm
        variant={variant}
        job={null}
        initial={{}}
        onSaved={(job) => {
          store.getState().jobSaved(job);
          onSaved(job);
        }}
        onCancel={onCancel}
      />
    </div>
  );
}
