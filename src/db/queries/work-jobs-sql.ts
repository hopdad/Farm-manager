/**
 * SQL fragments the job board's queries share (slice 2a, jobs-api), built from the domain's
 * constants only (never from input).
 */
import { OPEN_JOB_STATUSES } from '../../domain/work-jobs';

/** `('requested', 'planned', 'assigned', 'pushed', 'in_progress')`: for `status in …`. */
export const OPEN_STATUS_SQL = `(${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(', ')})`;
