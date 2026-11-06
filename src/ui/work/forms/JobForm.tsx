'use client';
/**
 * The new and edit job form (slice 2a; docs/contracts-2a.md §7.3): kind, business line,
 * customer, field, window, crop year, planned qty / unit / acres, products with rate, unit and
 * supplied-by, notes, request channel and requester. It loads its choices from GET
 * /api/v1/job-options and saves through POST /api/v1/jobs (new) or PATCH /api/v1/jobs/<id>
 * (edit, with the job's version; a 409 shows JOB_CONFLICT_MESSAGE with the current job).
 * Rendered by the board (wall popover, phone sheet) and by the field panel's Jobs tab ("New job
 * here", `initial.fieldId`).
 *
 * FOUNDATION STUB, owned by the job-forms builder (src/ui/work/forms/**). Props frozen
 * (additive changes only). Test ids: contracts-2a §7.5.
 */
import type { BusinessLine, JobKind } from '../../../domain/work-jobs';
import type { MapVariant } from '../../map/types';
import type { JobView } from '../contract';

export interface JobFormProps {
  variant: MapVariant;
  /** The job to edit; null or absent = a new job. */
  job?: JobView | null;
  /** Pre-filled values of a new job (a field tapped, a lane's "New job"). */
  initial?: { fieldId?: string; kind?: JobKind; businessLine?: BusinessLine };
  /** Saved: the job as the server answered it. */
  onSaved(job: JobView): void;
  onCancel(): void;
}

export function JobForm({ onCancel }: JobFormProps) {
  return (
    <div data-testid="job-form" data-stub="true">
      <p>The job form arrives with slice 2a.</p>
      <button type="button" onClick={onCancel} data-testid="job-form-cancel">
        Close
      </button>
    </div>
  );
}
