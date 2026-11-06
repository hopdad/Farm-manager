/**
 * Farm work jobs (slice 2a, the job board; docs/contracts-2a.md §4): the vocabulary of
 * farm.products, farm.jobs, farm.job_assignments, farm.job_products,
 * farm.data_rights_agreements, farm.job_request_links and app.usage_events. The database
 * enforces the same lists with CHECK constraints (db/migrations/0008_m2a_job_board.sql), the
 * Drizzle schema types columns with them, and the API contract (src/ui/work/contract.ts) builds
 * its zod enums from them. Pure TS.
 *
 * "Work jobs", never plain "jobs" in code: `src/jobs/**`, `/api/jobs/[name]`, `ingest.job_runs`
 * and JOBS_SECRET are the scheduled-job runner (contracts-2a §4.1).
 *
 * Ownership (contracts-2a §1): the CONSTS, TYPES and LABELS here are the foundation's and frozen
 * (additive changes only, through a contract change). The FUNCTIONS at the end have fixed
 * signatures: the status machine and the automatic moves are implemented (the foundation, so
 * the board can draw its status buttons before the merge; jobs-api owns the bodies from here:
 * the exhaustive tests and any correction), the summary and the conflict flags are stubs that
 * jobs-api fills in. jobs-api may add new pure functions below the "SIGNATURES FROZEN" line.
 */
import { ROLE_FOR, roleAtLeast } from '../platform/auth/types';
import type { AppRole } from './farm';
import type { OperationKind } from './operations';

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/** farm.jobs.kind (plan §4). */
export const JOB_KINDS = [
  'plant',
  'spray',
  'harvest',
  'haul',
  'tillage',
  'fertilize',
  'scout',
  'tile',
  'repair',
  'other',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * farm.jobs.business_line (plan §4), IN LANE ORDER: the board shows one lane per business line,
 * left to right (decision 2a-1: "cards by crew" = one lane per business line).
 */
export const BUSINESS_LINES = ['spraying', 'grain', 'trucking', 'store'] as const;
export type BusinessLine = (typeof BUSINESS_LINES)[number];

/**
 * farm.jobs.status (plan §4), in the order of the happy path (decision 2a-3):
 * requested -> planned -> assigned -> pushed -> in_progress -> done -> invoiced; cancelled from
 * any status before done. `pushed` is set only by 2b's Work Plan push, `invoiced` only by M3.
 */
export const JOB_STATUSES = [
  'requested',
  'planned',
  'assigned',
  'pushed',
  'in_progress',
  'done',
  'invoiced',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses the board shows as open cards (the board index's predicate is the complement). */
export const OPEN_JOB_STATUSES = [
  'requested',
  'planned',
  'assigned',
  'pushed',
  'in_progress',
] as const satisfies readonly JobStatus[];
export type OpenJobStatus = (typeof OPEN_JOB_STATUSES)[number];

/** Closed statuses: never on the board snapshot's lanes except `done` on its own farm day. */
export const CLOSED_JOB_STATUSES = [
  'done',
  'invoiced',
  'cancelled',
] as const satisfies readonly JobStatus[];

export function isOpenJobStatus(status: JobStatus): status is OpenJobStatus {
  return (OPEN_JOB_STATUSES as readonly string[]).includes(status);
}

/** farm.jobs.planned_unit: what planned_qty counts (plan §4: loads, bu, hours; + tons, gal). */
export const JOB_PLANNED_UNITS = ['loads', 'bu', 'hours', 'tons', 'gal'] as const;
export type JobPlannedUnit = (typeof JOB_PLANNED_UNITS)[number];

/**
 * farm.jobs.priority: 1 = urgent … 4 = low. A lane lists its open jobs by priority ascending,
 * then sort_key (a manager's order within a priority, POST /api/v1/jobs/reorder), then
 * created_at; the window shows on the card but doesn't order it (decision 2a-1). New jobs get
 * JOB_DEFAULT_PRIORITY.
 */
export const JOB_PRIORITIES = [1, 2, 3, 4] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];
export const JOB_DEFAULT_PRIORITY: JobPriority = 3;

/** farm.jobs.request_channel: how a customer asked (decision 2a-9; no SMS or voice link, D20). */
export const REQUEST_CHANNELS = ['text', 'phone', 'in_person', 'web_form'] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

/** farm.jobs.source values the app writes (no CHECK: imports and syncs may add their own). */
export const JOB_SOURCE_APP = 'app';
export const JOB_SOURCE_DEMO = 'demo';

/**
 * farm.job_assignments.role: `operator` when the row has a machine, else `crew` (decision 2a-4:
 * "SP2, then an operator" is one row, SP2 run by Dale).
 */
export const ASSIGNMENT_ROLES = ['operator', 'crew'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

// ---------------------------------------------------------------------------------------------
// Products (decision 2a-12)
// ---------------------------------------------------------------------------------------------

/** farm.products.kind (plan §4). 2b maps them to OperationProduct kinds (fuel -> other). */
export const PRODUCT_KINDS = ['seed', 'chemical', 'fertilizer', 'fuel'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** farm.products.unit: the unit a product is bought and stocked in. */
export const PRODUCT_UNITS = [
  'gal',
  'qt',
  'pt',
  'floz',
  'lb',
  'oz',
  'ton',
  'bag',
  'unit',
  'kseed',
] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/**
 * farm.job_products.unit: a rate per acre (`*_ac`) or a total for the job (`gal`, `lb`, `ton`,
 * `unit`). `unit_ac` = seed units (80,000 kernels of corn, 140,000 soybeans) per acre.
 */
export const RATE_UNITS = [
  'gal_ac',
  'qt_ac',
  'pt_ac',
  'floz_ac',
  'lb_ac',
  'oz_ac',
  'ton_ac',
  'unit_ac',
  'kseed_ac',
  'gal',
  'lb',
  'ton',
  'unit',
] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** farm.job_products.supplied_by: whose product goes on (plan §4; M3 bills ours). */
export const SUPPLIED_BY = ['us', 'customer'] as const;
export type SuppliedBy = (typeof SUPPLIED_BY)[number];

// ---------------------------------------------------------------------------------------------
// Data-rights agreements (D17, decision 2a-10) and usage events (decision 2a-11)
// ---------------------------------------------------------------------------------------------

/** farm.data_rights_agreements.permitted_uses ⊆ these (plan §4). */
export const PERMITTED_USES = ['billing', 'agronomy', 'prospecting', 'landlord_sharing'] as const;
export type PermittedUse = (typeof PERMITTED_USES)[number];

/**
 * app.usage_events.kind. `morning_run` is reserved for 2b's morning meeting mode (the 2a report
 * shows "starts in 2b").
 */
export const USAGE_KINDS = [
  'page_view',
  'board_heartbeat',
  'pin_sign_in',
  'job_action',
  'morning_run',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** At most one usage row per device + person + kind + route per this many minutes. */
export const USAGE_BUCKET_MINUTES = 5;
/**
 * The board posts a heartbeat this often while it is visible (4 minutes: below the bucket, so
 * timer drift never skips a bucket; board time = the buckets with at least one heartbeat × 5
 * minutes). The server records it only for a session with a person (appUserId set): an
 * unattended wall logs no board time (contracts-2a §7.7).
 */
export const USAGE_HEARTBEAT_MS = 4 * 60_000;
/** Usage rows are kept this long (the gate report must cover the whole of planting). */
export const USAGE_RETENTION_DAYS = 400;
/** Farm days the /admin/usage report lists. */
export const USAGE_REPORT_DAYS = 30;
/**
 * The Phase 2 gate line (plan §6: "crew uses the board every day"): a farm day passes with at
 * least this many active crew (app role driver, operator or manager; the owner, demo and e2e
 * people excluded). Sundays are not counted. Derrick can change it (decision 2a-11).
 */
export const PHASE2_MIN_DAILY_CREW = 2;
/** App roles that count as crew for the gate (the owner never does). */
export const CREW_APP_ROLES = [
  'driver',
  'operator',
  'manager',
] as const satisfies readonly AppRole[];
/** Days of the week (0 = Sunday, America/Detroit) the gate line ignores. */
export const GATE_SKIPPED_WEEKDAYS: readonly number[] = [0];

/**
 * app.usage_events.actor_key: '<device id or ->:<app user id or ->' at write time (the bucket
 * key stays the same when the person or device is deleted later and its id is set null).
 */
export function usageActorKey(deviceId: string | null, appUserId: string | null): string {
  return `${deviceId ?? '-'}:${appUserId ?? '-'}`;
}

/** app.usage_events.bucket_at: `at` floored to USAGE_BUCKET_MINUTES (UTC; 5 divides an hour). */
export function usageBucketStart(at: Date): Date {
  const ms = USAGE_BUCKET_MINUTES * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

// ---------------------------------------------------------------------------------------------
// Limits shared by the API, the forms and the database
// ---------------------------------------------------------------------------------------------

export const MAX_JOB_TITLE_CHARS = 80;
export const MAX_JOB_NOTES_CHARS = 4_000;
export const MAX_CANCEL_REASON_CHARS = 500;
export const MAX_REQUESTER_NAME_CHARS = 120;
export const MAX_REQUESTER_PHONE_CHARS = 40;
export const MAX_PRODUCT_NAME_CHARS = 120;
export const MAX_JOB_PRODUCTS = 20;
export const MAX_REORDER_JOBS = 200;
/** A request link answers at most this many POSTs per farm day (decision 2a-9). */
export const REQUEST_LINK_MAX_PER_DAY = 20;
/** Bytes of entropy in a request-link token (128 bits, base64url in the URL). */
export const REQUEST_LINK_TOKEN_BYTES = 16;
/**
 * The jobs publish triggers send `jobs`/`invalidate { reason: 'too_large' }` instead of
 * `jobs`/`updated` when the payload text would pass this many bytes (decision 2a-8; under
 * MAX_PAYLOAD_BYTES 7,500, with room for the seq and the wrapper).
 */
export const JOBS_TRIGGER_MAX_PAYLOAD_BYTES = 7_000;
/**
 * Planned acres that differ from the field's current boundary acres by more than this fraction
 * show both on the card (decision 2a-5).
 */
export const ACRES_DIFFER_FRACTION = 0.01;

/**
 * What a card flags (JobView.flags, in this order): no field yet; a machine on it is down; a
 * machine or person on it is also on another open job whose window overlaps (contracts-2a §4.5);
 * planned acres differ from the boundary's by more than ACRES_DIFFER_FRACTION; a restricted-use
 * product is on it. src/ui/work/contract.ts re-exports these.
 */
export const JOB_FLAGS = [
  'no_field',
  'machine_down',
  'double_booked',
  'acres_differ',
  'restricted_use',
] as const;
export type JobFlag = (typeof JOB_FLAGS)[number];

// ---------------------------------------------------------------------------------------------
// Labels (one place; the board, the forms, the field tab and /admin use them)
// ---------------------------------------------------------------------------------------------

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  plant: 'Plant',
  spray: 'Spray',
  harvest: 'Harvest',
  haul: 'Haul',
  tillage: 'Tillage',
  fertilize: 'Fertilize',
  scout: 'Scout',
  tile: 'Tile',
  repair: 'Repair',
  other: 'Other',
};

export const BUSINESS_LINE_LABELS: Record<BusinessLine, string> = {
  spraying: 'Spraying',
  grain: 'Grain',
  trucking: 'Trucking',
  store: 'Store',
};

/** The lane a new job of each kind starts in (the form can pick another). */
export const DEFAULT_BUSINESS_LINE: Record<JobKind, BusinessLine> = {
  plant: 'grain',
  spray: 'spraying',
  harvest: 'grain',
  haul: 'trucking',
  tillage: 'grain',
  fertilize: 'spraying',
  scout: 'spraying',
  tile: 'grain',
  repair: 'grain',
  other: 'grain',
};

/**
 * The Deere operation kind a job of each kind matches (src/domain/operations.ts OPERATION_KINDS):
 * 2b matches farm.operations to jobs on field + window + this kind and pushes Work Plans only for
 * jobs that have one; null = never a Work Plan or an operation (a haul, a repair, a scout). The
 * board shows the machine chip's "Deere" badge on a card only when this is set (decision 2a-13).
 */
export const JOB_OPERATION_KIND: Record<JobKind, OperationKind | null> = {
  plant: 'seeding',
  spray: 'application',
  harvest: 'harvest',
  haul: null,
  tillage: 'tillage',
  fertilize: 'application',
  scout: null,
  tile: null,
  repair: null,
  other: null,
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  requested: 'Requested',
  planned: 'Planned',
  assigned: 'Assigned',
  pushed: 'Sent to cab',
  in_progress: 'In progress',
  done: 'Done',
  invoiced: 'Invoiced',
  cancelled: 'Cancelled',
};

export const JOB_PRIORITY_LABELS: Record<JobPriority, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low',
};

export const JOB_PLANNED_UNIT_LABELS: Record<JobPlannedUnit, string> = {
  loads: 'loads',
  bu: 'bu',
  hours: 'hours',
  tons: 'tons',
  gal: 'gal',
};

export const REQUEST_CHANNEL_LABELS: Record<RequestChannel, string> = {
  text: 'Text message',
  phone: 'Phone call',
  in_person: 'In person',
  web_form: 'Request link',
};

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  operator: 'Operator',
  crew: 'Crew',
};

export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  seed: 'Seed',
  chemical: 'Chemical',
  fertilizer: 'Fertilizer',
  fuel: 'Fuel',
};

export const PRODUCT_UNIT_LABELS: Record<ProductUnit, string> = {
  gal: 'gal',
  qt: 'qt',
  pt: 'pt',
  floz: 'fl oz',
  lb: 'lb',
  oz: 'oz',
  ton: 'ton',
  bag: 'bag',
  unit: 'unit',
  kseed: '1,000 seeds',
};

export const RATE_UNIT_LABELS: Record<RateUnit, string> = {
  gal_ac: 'gal/ac',
  qt_ac: 'qt/ac',
  pt_ac: 'pt/ac',
  floz_ac: 'fl oz/ac',
  lb_ac: 'lb/ac',
  oz_ac: 'oz/ac',
  ton_ac: 'ton/ac',
  unit_ac: 'units/ac',
  kseed_ac: 'k seeds/ac',
  gal: 'gal total',
  lb: 'lb total',
  ton: 'ton total',
  unit: 'units total',
};

export const SUPPLIED_BY_LABELS: Record<SuppliedBy, string> = {
  us: 'Our product',
  customer: "Customer's product",
};

export const PERMITTED_USE_LABELS: Record<PermittedUse, string> = {
  billing: 'Billing',
  agronomy: 'Agronomy',
  prospecting: 'Prospecting',
  landlord_sharing: 'Sharing with landlords',
};

export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  page_view: 'Page view',
  board_heartbeat: 'Board time',
  pin_sign_in: 'PIN sign-in',
  job_action: 'Job action',
  morning_run: 'Morning mode',
};

// ---------------------------------------------------------------------------------------------
// The status machine (decision 2a-3) and job rules: SIGNATURES FROZEN, bodies by jobs-api
// ---------------------------------------------------------------------------------------------

/**
 * Who asks for a status change. `via` is 'person' for everything 2a writes; 2b's Work Plan push
 * uses 'work_plan' (the only way to `pushed`) and M3 'billing' (the only way to `invoiced`).
 */
export interface JobActor {
  /** The session's effective role. */
  role: AppRole;
  /** Is the person on one of the job's assignments (their party)? */
  ownJob: boolean;
  via?: 'person' | 'work_plan' | 'billing';
}

export type JobTransitionCheck =
  | { ok: true }
  | {
      ok: false;
      /** 'same': already there; 'not_allowed': no such move; 'forbidden': not for this role. */
      reason: 'same' | 'not_allowed' | 'forbidden';
      message: string;
    };

/** A move of the status machine and the `via` that may make it (decision 2a-3). */
interface JobMove {
  from: JobStatus;
  to: JobStatus;
  via: NonNullable<JobActor['via']>;
}

/**
 * Every move a status change may make (contracts-2a §4.3). planned -> assigned and
 * assigned -> planned are NOT here: they happen only through autoJobStatus when a write sets the
 * field or the assignments. Nothing goes back to `requested`.
 */
const JOB_MOVES: readonly JobMove[] = [
  { from: 'requested', to: 'planned', via: 'person' },
  { from: 'assigned', to: 'pushed', via: 'work_plan' },
  { from: 'assigned', to: 'in_progress', via: 'person' },
  { from: 'pushed', to: 'in_progress', via: 'person' },
  { from: 'in_progress', to: 'done', via: 'person' },
  { from: 'done', to: 'in_progress', via: 'person' },
  { from: 'done', to: 'invoiced', via: 'billing' },
  ...OPEN_JOB_STATUSES.map((from) => ({ from, to: 'cancelled' as const, via: 'person' as const })),
];

/** The moves a driver or operator may make on their own job (decision 2a-2). */
const OWN_JOB_MOVES: readonly { from: JobStatus; to: JobStatus }[] = [
  { from: 'assigned', to: 'in_progress' },
  { from: 'pushed', to: 'in_progress' },
  { from: 'in_progress', to: 'done' },
];

const VIA_ONLY: Record<'work_plan' | 'billing', string> = {
  work_plan: 'only the Work Plan push (2b) sends a job to the cab',
  billing: 'only billing (M3) marks a job invoiced',
};

/**
 * May `who` move a job from `from` to `to` (decision 2a-3 for the moves, 2a-2 for the roles)?
 * In this order: the same status is 'same'; a move the machine doesn't have for `who.via`
 * (default 'person') is 'not_allowed', for every role (assigned -> pushed only via 'work_plan',
 * done -> invoiced only via 'billing'; planned -> assigned only by the automatic move); then the
 * role: `planJobs` (manager and up) may make any of them (cancel from any open status;
 * done -> in_progress for mistakes; requested -> planned is "accept"); below that,
 * `updateOwnJobStatus` (driver, operator) only on their OWN job (`ownJob`: their party is on one
 * of its assignments; a session with no person has no own job) and only assigned/pushed ->
 * in_progress and in_progress -> done; viewers nothing. A refusal by role is 'forbidden' (the
 * route answers 403), 'not_allowed' and 'same' answer 422. The /status route refuses
 * `cancelled` itself ('not_allowed': use /cancel), so the reason travels with the cancel.
 */
export function checkJobTransition(
  from: JobStatus,
  to: JobStatus,
  who: JobActor,
): JobTransitionCheck {
  if (from === to) {
    return { ok: false, reason: 'same', message: `the job is already ${JOB_STATUS_LABELS[to]}` };
  }
  const via = who.via ?? 'person';
  const moves = JOB_MOVES.filter((m) => m.from === from && m.to === to);
  if (!moves.some((m) => m.via === via)) {
    const only = moves.find((m) => m.via !== 'person')?.via;
    const message =
      only === 'work_plan' || only === 'billing'
        ? VIA_ONLY[only]
        : from === 'planned' && to === 'assigned'
          ? 'a job becomes Assigned by itself once it has a field and a machine or person'
          : `a job can't go from ${JOB_STATUS_LABELS[from]} to ${JOB_STATUS_LABELS[to]}`;
    return { ok: false, reason: 'not_allowed', message };
  }
  if (roleAtLeast(who.role, ROLE_FOR.planJobs)) return { ok: true };
  const ownMove = via === 'person' && OWN_JOB_MOVES.some((m) => m.from === from && m.to === to);
  if (ownMove && roleAtLeast(who.role, ROLE_FOR.updateOwnJobStatus)) {
    return who.ownJob
      ? { ok: true }
      : { ok: false, reason: 'forbidden', message: 'only the people on this job can change it' };
  }
  return { ok: false, reason: 'forbidden', message: 'only a manager can make this change' };
}

/**
 * The statuses `who` may move a job in `from` to, in JOB_STATUSES order (the job detail's status
 * buttons; `cancelled`, when present, is the Cancel button, which posts to …/cancel).
 */
export function nextJobStatuses(from: JobStatus, who: JobActor): JobStatus[] {
  return JOB_STATUSES.filter((to) => checkJobTransition(from, to, who).ok);
}

/**
 * The automatic move after a write that changes the field or the assignments (decision 2a-3):
 * a requested or planned job that has a field and at least one assignment becomes `assigned`;
 * an assigned job with no assignment left goes back to `planned`; anything else keeps its status
 * (an assigned job whose field is cleared stays assigned, flagged `no_field`).
 */
export function autoJobStatus(
  status: JobStatus,
  job: { hasField: boolean; assignmentCount: number },
): JobStatus {
  if ((status === 'requested' || status === 'planned') && job.hasField && job.assignmentCount > 0) {
    return 'assigned';
  }
  if (status === 'assigned' && job.assignmentCount === 0) return 'planned';
  return status;
}

/**
 * The card's one-line summary when the job has no title ("Spray · Halvorsen Corwin 80 · 78 ac").
 * jobs-api implements it; the stub returns the kind's label.
 */
export function jobSummary(job: {
  kind: JobKind;
  title: string | null;
  fieldName: string | null;
  plannedAcres: number | null;
  plannedQty: number | null;
  plannedUnit: JobPlannedUnit | null;
}): string {
  return job.title ?? JOB_KIND_LABELS[job.kind];
}

/** What jobFlags needs about one job (jobs-api's queries gather it). */
export interface JobFlagInput {
  hasField: boolean;
  plannedAcres: number | null;
  /** The field's current boundary acres (null: no field or no boundary). */
  boundaryAcres: number | null;
  /** How many machines on the job are down. */
  machinesDown: number;
  /**
   * How many of its assignments share a machine or person with another open job whose window
   * overlaps (contracts-2a §4.5: coalesce(planned_for, the job's window); null never overlaps).
   */
  overlaps: number;
  /** A restricted-use product is on it. */
  restrictedUse: boolean;
}

/**
 * The card's flags, in JOB_FLAGS order (acres_differ when both acres are known and differ by
 * more than ACRES_DIFFER_FRACTION of the boundary's). jobs-api implements it; the stub flags
 * nothing.
 */
export function jobFlags(_job: JobFlagInput): JobFlag[] {
  return [];
}
