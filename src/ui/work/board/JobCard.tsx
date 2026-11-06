'use client';
/**
 * A job card (docs/contracts-2a.md §7.1 "Cards", test ids §7.5): the status colour, the kind's
 * glyph, the summary, field and acres, the window (shown, never sorted by: decision 2a-1), the
 * products, the flags and the assignment chips ("SP2 · Dale Mercer", the machine's "Deere" badge
 * only for kinds that become a Work Plan, × for planners).
 *
 * A planner drags an OPEN card from anywhere on it (dnd-kit: the mouse after 6 px, a finger
 * after a 200 ms hold; a quick swipe scrolls the lane instead); the grip is also the keyboard's
 * handle. A tap opens the job detail. Viewers and crew get no grip, no drag and no ×.
 */
import { useDraggable } from '@dnd-kit/core';
import type { CSSProperties, MouseEvent, SyntheticEvent } from 'react';
import type { JobFlag } from '../../../domain/work-jobs';
import type { MapVariant } from '../../map/types';
import type { JobView } from '../contract';
import { JOB_KIND_GLYPHS, kindLabel, statusLook } from '../style';
import { type DragData, jobCardId } from './drop';
import { type CardView, cardView, FLAG_LABELS, WARNING_FLAGS } from './model';
import { useClock } from './useClock';
import css from './work-board.module.css';

export interface JobCardProps {
  job: JobView;
  variant: MapVariant;
  /** The viewer may plan jobs (drag, ×). */
  planner: boolean;
  /** A write for this job is in flight. */
  saving: boolean;
  /** Its detail is open. */
  selected: boolean;
  onOpen(jobId: string, anchor: DOMRect | null): void;
  onUnassign(jobId: string, assignmentId: string): void;
}

/** Keep a press on a control inside the card from starting a drag of the card. */
const stop = (e: SyntheticEvent) => e.stopPropagation();

function CardBody({ view, job }: { view: CardView; job: JobView }) {
  const look = statusLook(job.status);
  // "No field yet" once: the flag's tag on the field line when the server flags it.
  const noFieldTag = !view.fieldName && view.flags.includes('no_field');
  const flags = noFieldTag ? view.flags.filter((f) => f !== 'no_field') : view.flags;
  const flagTag = (f: JobFlag) => (
    <span
      key={f}
      className={`${css.flag} ${WARNING_FLAGS.has(f) ? css.flagWarn : ''}`}
      data-testid="job-flag"
      data-flag={f}
    >
      {FLAG_LABELS[f]}
    </span>
  );
  return (
    <>
      <span className={css.cardTop}>
        <span className={css.glyph} title={kindLabel(job.kind)}>
          {JOB_KIND_GLYPHS[job.kind]}
        </span>
        <span className={css.summary}>{view.summary}</span>
      </span>
      <span className={css.cardLine}>
        <span
          className={css.statusTag}
          style={{ background: look.fill, color: look.text }}
          data-testid="job-card-status"
        >
          {look.label}
        </span>
        {view.window && <span className={css.muted}>{view.window}</span>}
      </span>
      <span className={css.cardLine}>
        {view.fieldName ? (
          <span className={css.fieldName}>{view.fieldName}</span>
        ) : noFieldTag ? (
          flagTag('no_field')
        ) : (
          <span className={css.muted}>No field yet</span>
        )}
        {view.acres && <span className={css.acres}>{view.acres}</span>}
      </span>
      {(view.priorityLabel || flags.length > 0 || view.products) && (
        <span className={css.cardLine}>
          {view.priorityLabel && <span className={css.priority}>{view.priorityLabel}</span>}
          {flags.map(flagTag)}
          {view.products && <span className={css.muted}>{view.products}</span>}
        </span>
      )}
    </>
  );
}

export function JobCard(props: JobCardProps) {
  const { job, variant, planner } = props;
  const now = useClock();
  const view = cardView(job, new Date(now), { compact: variant === 'wall' });
  const draggable = planner && view.open;
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: jobCardId(job.id),
    data: { kind: 'job', jobId: job.id } satisfies DragData,
    disabled: !draggable,
  });
  const look = statusLook(job.status);
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const card = e.currentTarget.closest('[data-testid="job-card"]');
    props.onOpen(job.id, card ? card.getBoundingClientRect() : null);
  };
  return (
    <article
      ref={setNodeRef}
      className={`${css.card} ${variant === 'phone' ? css.cardPhone : css.cardWall} ${
        props.selected ? css.cardSelected : ''
      } ${isDragging ? css.cardDragging : ''}`}
      style={{ '--status-fill': look.fill } as CSSProperties}
      data-testid="job-card"
      data-job-id={job.id}
      data-status={job.status}
      data-business-line={job.businessLine}
      data-field-id={job.field?.id ?? ''}
      data-version={job.version}
      data-draggable={draggable ? 'true' : 'false'}
      data-saving={props.saving ? 'true' : 'false'}
      aria-busy={props.saving || undefined}
      {...(draggable ? listeners : {})}
    >
      <button
        type="button"
        className={css.cardOpen}
        onClick={open}
        aria-label={`${view.summary}: ${look.label}. Open the job`}
      >
        <CardBody view={view} job={job} />
      </button>
      {view.assignments.length > 0 && (
        <ul className={css.cardChips} aria-label="On this job">
          {view.assignments.map((a) => (
            <li
              key={a.id}
              className={`${css.assignment} ${a.down ? css.assignmentDown : ''}`}
              data-testid="job-assignment-chip"
              data-assignment-id={a.id}
              data-machine-id={a.machineId ?? ''}
              data-party-id={a.partyId ?? ''}
            >
              <span className={css.assignmentLabel} data-testid="job-assignment-label">
                {a.label}
              </span>
              {a.down && <span className={css.downTag}>down</span>}
              {a.deere && <span className={css.deere}>Deere</span>}
              {planner && (
                <button
                  type="button"
                  className={css.remove}
                  data-testid="job-assignment-remove"
                  aria-label={`Take ${a.label} off this job`}
                  onMouseDown={stop}
                  onTouchStart={stop}
                  onPointerDown={stop}
                  onKeyDown={stop}
                  onClick={() => props.onUnassign(job.id, a.id)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {draggable && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={css.grip}
          data-testid="job-drag-handle"
          {...attributes}
          aria-label={`Move ${view.summary} onto a field, a machine or a person`}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      )}
    </article>
  );
}

/** The copy under the finger while a card is dragged (the DragOverlay's content). */
export function OverlayCard({ job, variant }: { job: JobView; variant: MapVariant }) {
  const now = useClock();
  const view = cardView(job, new Date(now), { compact: variant === 'wall' });
  const look = statusLook(job.status);
  return (
    <div
      className={`${css.card} ${css.cardOverlay} ${variant === 'phone' ? css.cardPhone : css.cardWall}`}
      style={{ '--status-fill': look.fill } as CSSProperties}
      data-testid="job-drag-overlay"
      data-job-id={job.id}
    >
      <span className={css.cardOpen}>
        <CardBody view={view} job={job} />
      </span>
    </div>
  );
}
