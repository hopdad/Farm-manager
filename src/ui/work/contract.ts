/**
 * The job board's API (slice 2a; docs/contracts-2a.md §5): zod schemas, route URLs and the view
 * types the routes, the queries, the board and the forms share. Pure TS + zod. A CONTRACT FILE:
 * the foundation owns it; builders compile against it and ask for changes in their report
 * (additive only).
 *
 * Every route is a versioned route handler under /api/v1 (2c's offline outbox posts job status
 * there, plan §1), answers JSON through limitedJson with `cache-control: no-store`, and checks
 * the session FIRST (requireRole). Writes are same-origin JSON of at most JOB_BODY_MAX_BYTES:
 *
 *   GET    /api/v1/jobs[?fieldId=]             viewer   -> BoardSnapshot (boardSnapshotSchema)
 *   POST   /api/v1/jobs                        planJobs <- CreateJobBody     -> 201 JobResponse
 *   GET    /api/v1/jobs/<id>                   viewer   -> JobResponse
 *   PATCH  /api/v1/jobs/<id>                   planJobs <- UpdateJobBody     -> JobResponse | 409
 *   PUT    /api/v1/jobs/<id>/field             planJobs <- SetJobFieldBody   -> JobResponse | 409 | 422
 *   POST   /api/v1/jobs/<id>/assignments       planJobs <- AssignJobBody     -> JobResponse | 409 | 422
 *   DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=machine|person]
 *                                              planJobs                      -> JobResponse | 409
 *   POST   /api/v1/jobs/<id>/status            updateOwnJobStatus (driver; own job unless a
 *                                              manager) <- SetJobStatusBody  -> JobResponse | 409 | 422
 *   POST   /api/v1/jobs/<id>/cancel            planJobs <- CancelJobBody     -> JobResponse | 409 | 422
 *   POST   /api/v1/jobs/reorder                planJobs <- ReorderJobsBody   -> BoardSnapshot | 409
 *   GET    /api/v1/crew                        viewer   -> CrewResponse
 *   GET    /api/v1/job-options                 viewer   -> JobOptionsResponse (the job form)
 *   POST   /api/v1/usage                       viewer   <- UsageHeartbeatBody -> UsageHeartbeatResponse
 *
 * Status codes: 400 bad JSON or body ({ error }), 401/403 session ({ error, status, required }
 * from authErrorResponse; 403 { error } for "not your job" or a cross-site request), 404 unknown
 * id, 409 stale `version` (JobConflictResponse: the CURRENT job, same shape as GET), 413 body
 * too large, 415 not JSON, 422 a rule refused it ({ error, reason? }: "not on a field", a status
 * move the machine refuses, a retired machine), 503 database failure. A 409 never changes
 * anything: the client refetches and says JOB_CONFLICT_MESSAGE.
 *
 * Realtime: job writes publish nothing from TypeScript; the jobs triggers send `jobs`/`updated`
 * (JobsUpdatedPayload) on commit (decision 2a-8, contracts-2a §6).
 */
import { z } from 'zod';
import { APP_ROLES, PARTY_KINDS } from '../../domain/farm';
import { MACHINE_KINDS, MACHINE_STATUSES } from '../../domain/fleet';
import {
  ASSIGNMENT_ROLES,
  BUSINESS_LINES,
  JOB_FLAGS,
  JOB_KINDS,
  JOB_PLANNED_UNITS,
  JOB_STATUSES,
  MAX_CANCEL_REASON_CHARS,
  MAX_JOB_NOTES_CHARS,
  MAX_JOB_PRODUCTS,
  MAX_JOB_TITLE_CHARS,
  MAX_REORDER_JOBS,
  MAX_REQUESTER_NAME_CHARS,
  MAX_REQUESTER_PHONE_CHARS,
  PRODUCT_KINDS,
  PRODUCT_UNITS,
  RATE_UNITS,
  REQUEST_CHANNELS,
  SUPPLIED_BY,
} from '../../domain/work-jobs';

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

export const JOBS_URL = '/api/v1/jobs';
const enc = encodeURIComponent;

/** The board snapshot; `fieldId` narrows it to one field's jobs (the field panel's Jobs tab). */
export function jobsUrl(query: { fieldId?: string } = {}): string {
  return query.fieldId ? `${JOBS_URL}?fieldId=${enc(query.fieldId)}` : JOBS_URL;
}
export const jobUrl = (id: string) => `${JOBS_URL}/${enc(id)}`;
export const jobFieldUrl = (id: string) => `${jobUrl(id)}/field`;
export const jobAssignmentsUrl = (id: string) => `${jobUrl(id)}/assignments`;
export function jobAssignmentUrl(
  id: string,
  assignmentId: string,
  version: number,
  part?: AssignmentPart,
): string {
  const q = `version=${version}${part ? `&part=${part}` : ''}`;
  return `${jobAssignmentsUrl(id)}/${enc(assignmentId)}?${q}`;
}
export const jobStatusUrl = (id: string) => `${jobUrl(id)}/status`;
export const jobCancelUrl = (id: string) => `${jobUrl(id)}/cancel`;
export const JOBS_REORDER_URL = `${JOBS_URL}/reorder`;
export const CREW_URL = '/api/v1/crew';
export const JOB_OPTIONS_URL = '/api/v1/job-options';
export const USAGE_URL = '/api/v1/usage';

/** Largest JSON body a job write accepts (a job with MAX_JOB_PRODUCTS products fits easily). */
export const JOB_BODY_MAX_BYTES = 32 * 1024;

/** What the client says after a 409 (decision 2a-7). */
export const JOB_CONFLICT_MESSAGE = 'Changed on another screen; try again';

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

const iso = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);

/** [from, to) in ISO time; null bound = open. A window with both bounds needs from < to. */
export const jobWindowSchema = z
  .object({ from: iso.nullable(), to: iso.nullable() })
  .refine((w) => w.from === null || w.to === null || Date.parse(w.from) < Date.parse(w.to), {
    message: 'the window must end after it starts',
  });
export type JobWindow = z.infer<typeof jobWindowSchema>;

export const lngLatSchema = z.strictObject({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type LngLat = z.infer<typeof lngLatSchema>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** One product on a job, as the forms send it (the job's product list is replaced as a whole). */
export const jobProductInputSchema = z.strictObject({
  productId: z.uuid(),
  rate: z.number().min(0).nullable().optional(),
  unit: z.enum(RATE_UNITS).nullable().optional(),
  suppliedBy: z.enum(SUPPLIED_BY).default('us'),
});
export type JobProductInput = z.infer<typeof jobProductInputSchema>;

/** Who asked, for a `requested` job (decision 2a-9): a customer party, or a name and phone. */
export const jobRequestInputSchema = z.strictObject({
  channel: z.enum(REQUEST_CHANNELS),
  partyId: z.uuid().nullable().optional(),
  name: optionalText(MAX_REQUESTER_NAME_CHARS),
  phone: optionalText(MAX_REQUESTER_PHONE_CHARS),
});
export type JobRequestInput = z.infer<typeof jobRequestInputSchema>;

const priority = z.number().int().min(1).max(4);

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/v1/jobs. Defaults: businessLine = DEFAULT_BUSINESS_LINE[kind]; status 'planned'
 * ('requested' when `request` is given and status is absent); priority JOB_DEFAULT_PRIORITY.
 * With a field: the field rules of decision 2a-4/5/6 apply (customer from the field's farm when
 * none is given, planned acres from the boundary unless `plannedAcres` is given, which marks
 * them typed by hand; crop year from the field's growing year unless given).
 */
export const createJobBodySchema = z.strictObject({
  kind: z.enum(JOB_KINDS),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  status: z.enum(['requested', 'planned']).optional(),
  title: optionalText(MAX_JOB_TITLE_CHARS),
  fieldId: z.uuid().nullable().optional(),
  customerPartyId: z.uuid().nullable().optional(),
  window: jobWindowSchema.nullable().optional(),
  cropYear: z.number().int().min(1950).max(2100).nullable().optional(),
  plannedAcres: z.number().min(0).nullable().optional(),
  plannedQty: z.number().min(0).nullable().optional(),
  plannedUnit: z.enum(JOB_PLANNED_UNITS).nullable().optional(),
  priority: priority.optional(),
  notes: optionalText(MAX_JOB_NOTES_CHARS),
  request: jobRequestInputSchema.nullable().optional(),
  products: z.array(jobProductInputSchema).max(MAX_JOB_PRODUCTS).optional(),
});
export type CreateJobBody = z.infer<typeof createJobBodySchema>;
/** What a client sends (defaults such as a product's `suppliedBy` may be left out). */
export type CreateJobBodyInput = z.input<typeof createJobBodySchema>;

/**
 * PATCH /api/v1/jobs/<id>: only the fields present change; `version` is the one the client saw.
 * `fieldId` here follows the same rules as PUT …/field. `plannedAcres: null` hands the acres back
 * to the field's boundary (planned_acres_by_hand = false); a number sets them by hand.
 * `products` replaces the job's whole product list. Status moves go through …/status and
 * …/cancel, never here.
 */
export const updateJobBodySchema = z.strictObject({
  version,
  kind: z.enum(JOB_KINDS).optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  title: optionalText(MAX_JOB_TITLE_CHARS),
  fieldId: z.uuid().nullable().optional(),
  customerPartyId: z.uuid().nullable().optional(),
  window: jobWindowSchema.nullable().optional(),
  cropYear: z.number().int().min(1950).max(2100).nullable().optional(),
  plannedAcres: z.number().min(0).nullable().optional(),
  plannedQty: z.number().min(0).nullable().optional(),
  plannedUnit: z.enum(JOB_PLANNED_UNITS).nullable().optional(),
  priority: priority.optional(),
  notes: optionalText(MAX_JOB_NOTES_CHARS),
  request: jobRequestInputSchema.nullable().optional(),
  products: z.array(jobProductInputSchema).max(MAX_JOB_PRODUCTS).optional(),
});
export type UpdateJobBody = z.infer<typeof updateJobBodySchema>;
export type UpdateJobBodyInput = z.input<typeof updateJobBodySchema>;

/**
 * PUT /api/v1/jobs/<id>/field (a card dropped on the map, decision 2a-4): by id (the field the
 * client found with queryRenderedFeatures on `fields-fill`; null clears it) or by the drop
 * point (fields layer hidden or below z8): the server picks the field whose CURRENT boundary
 * contains it, else 422 { error: 'not on a field', reason: 'not_on_field' }.
 */
export const setJobFieldBodySchema = z.union([
  z.strictObject({ version, fieldId: z.uuid().nullable() }),
  z.strictObject({ version, at: lngLatSchema }),
]);
export type SetJobFieldBody = z.infer<typeof setJobFieldBodySchema>;

/**
 * POST /api/v1/jobs/<id>/assignments (a card dropped on a machine or person chip, decision
 * 2a-4). A machine fills the job's row that has a person but no machine (else a new row); a
 * person fills the row that has a machine but no person (else a new row). A machine or person
 * already on the job: nothing changes (200, same version). A down machine is accepted (flagged);
 * a retired one is 422.
 */
export const assignJobBodySchema = z
  .strictObject({ version, machineId: z.uuid().optional(), partyId: z.uuid().optional() })
  .refine((b) => b.machineId !== undefined || b.partyId !== undefined, {
    message: 'name a machine or a person',
  });
export type AssignJobBody = z.infer<typeof assignJobBodySchema>;

/** DELETE …/assignments/<aid>?part=: clear one side of a row (default: remove the whole row). */
export const ASSIGNMENT_PARTS = ['machine', 'person'] as const;
export type AssignmentPart = (typeof ASSIGNMENT_PARTS)[number];

/**
 * POST /api/v1/jobs/<id>/status: the move is checked by checkJobTransition (decision 2a-3).
 * `cancelled` is refused here (422 'not_allowed': use …/cancel, which takes the reason);
 * planned -> assigned is the automatic move only (422 'not_allowed').
 */
export const setJobStatusBodySchema = z.strictObject({ version, status: z.enum(JOB_STATUSES) });
export type SetJobStatusBody = z.infer<typeof setJobStatusBodySchema>;

/** POST /api/v1/jobs/<id>/cancel: any status before done, with an optional reason. */
export const cancelJobBodySchema = z.strictObject({
  version,
  reason: optionalText(MAX_CANCEL_REASON_CHARS),
});
export type CancelJobBody = z.infer<typeof cancelJobBodySchema>;

/**
 * POST /api/v1/jobs/reorder (the job detail's Move up / Move down, decision 2a-1): EVERY open job
 * of the lane in its new order, each with the version the client saw. sort_key follows the list
 * ((position + 1) × 10; a job whose sort_key changes gets version + 1); priority never changes
 * here, and a lane lists by priority, then sort_key, so a move only shows within its priority
 * (contracts-2a §5.2). One stale version answers 409 with that job; an open job of the lane
 * missing from the list answers 409 with it (it is new or moved there); a listed job that is
 * not open in that lane answers 422 'not_in_lane'. Nothing changes on a refusal.
 */
export const reorderJobsBodySchema = z.strictObject({
  businessLine: z.enum(BUSINESS_LINES),
  jobs: z
    .array(z.strictObject({ id: z.uuid(), version }))
    .min(1)
    .max(MAX_REORDER_JOBS),
});
export type ReorderJobsBody = z.infer<typeof reorderJobsBodySchema>;

/**
 * POST /api/v1/usage: the board's heartbeat every USAGE_HEARTBEAT_MS while visible. Recorded only
 * for a session with a person (appUserId); a device-only session answers `recorded: false`.
 */
export const usageHeartbeatBodySchema = z.strictObject({ route: z.enum(['/board', '/m']) });
export type UsageHeartbeatBody = z.infer<typeof usageHeartbeatBodySchema>;

// ---------------------------------------------------------------------------------------------
// Views (responses)
// ---------------------------------------------------------------------------------------------

/** A machine on an assignment (or a chip). `workPlanCapable`: the "Deere" badge (2a-13). */
export const jobMachineViewSchema = z.object({
  id: z.uuid(),
  unitNo: z.string(),
  kind: z.enum(MACHINE_KINDS),
  status: z.enum(MACHINE_STATUSES),
  workPlanCapable: z.boolean(),
});
export type JobMachineView = z.infer<typeof jobMachineViewSchema>;

/** A person on an assignment: their crew party. */
export const jobPersonViewSchema = z.object({
  partyId: z.uuid(),
  name: z.string(),
  /** Two letters for the chip ("DM" for Dale Mercer). */
  initials: z.string(),
});
export type JobPersonView = z.infer<typeof jobPersonViewSchema>;

export const jobAssignmentViewSchema = z.object({
  id: z.uuid(),
  role: z.enum(ASSIGNMENT_ROLES),
  machine: jobMachineViewSchema.nullable(),
  person: jobPersonViewSchema.nullable(),
  plannedFor: jobWindowSchema.nullable(),
  /**
   * Other open jobs with the same machine or person whose windows overlap (decision 2a-4:
   * flagged, never blocked): "also on <summary>".
   */
  alsoOn: z.array(z.object({ jobId: z.uuid(), summary: z.string() })),
});
export type JobAssignmentView = z.infer<typeof jobAssignmentViewSchema>;

export const jobProductViewSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  name: z.string(),
  kind: z.enum(PRODUCT_KINDS),
  rate: z.number().nullable(),
  unit: z.enum(RATE_UNITS).nullable(),
  suppliedBy: z.enum(SUPPLIED_BY),
  restrictedUse: z.boolean(),
  epaRegNo: z.string().nullable(),
});
export type JobProductView = z.infer<typeof jobProductViewSchema>;

/**
 * What a card flags (JOB_FLAGS, src/domain/work-jobs.ts, re-exported here): no field yet; a
 * machine on it is down; a machine or person is also on an overlapping open job; planned acres
 * differ from the boundary's by more than ACRES_DIFFER_FRACTION; a restricted-use product.
 */
export { JOB_FLAGS, type JobFlag } from '../../domain/work-jobs';

export const jobViewSchema = z.object({
  id: z.uuid(),
  version,
  kind: z.enum(JOB_KINDS),
  businessLine: z.enum(BUSINESS_LINES),
  status: z.enum(JOB_STATUSES),
  statusChangedAt: iso,
  title: z.string().nullable(),
  /** The title, else jobSummary() (src/domain/work-jobs.ts). */
  summary: z.string(),
  field: z
    .object({
      id: z.uuid(),
      name: z.string(),
      farmName: z.string().nullable(),
      /** The field's CURRENT boundary acres (shown beside planned acres when they differ). */
      boundaryAcres: z.number().nullable(),
    })
    .nullable(),
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  window: jobWindowSchema.nullable(),
  cropYear: z.number().int().nullable(),
  plannedAcres: z.number().nullable(),
  plannedAcresByHand: z.boolean(),
  plannedQty: z.number().nullable(),
  plannedUnit: z.enum(JOB_PLANNED_UNITS).nullable(),
  priority,
  sortKey: z.number(),
  notes: z.string().nullable(),
  request: z
    .object({
      channel: z.enum(REQUEST_CHANNELS),
      partyId: z.uuid().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      /** It came in through a request link (/r/<token>). */
      viaLink: z.boolean(),
    })
    .nullable(),
  cancelledReason: z.string().nullable(),
  deereWorkPlanId: z.string().nullable(),
  assignments: z.array(jobAssignmentViewSchema),
  products: z.array(jobProductViewSchema),
  flags: z.array(z.enum(JOB_FLAGS)),
  createdAt: iso,
  updatedAt: iso,
});
export type JobView = z.infer<typeof jobViewSchema>;

/** One lane = one business line (decision 2a-1), jobs in lane order. */
export const boardLaneSchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  label: z.string(),
  jobs: z.array(jobViewSchema),
});
export type BoardLane = z.infer<typeof boardLaneSchema>;

/**
 * GET /api/v1/jobs: every open job, plus jobs that went `done` on the current farm day, in
 * BUSINESS_LINES lanes (always all four, in order, empty ones included). `viewer` is a UI hint
 * (the server re-checks every write): `canPlan` = roleAtLeast(role, ROLE_FOR.planJobs).
 */
export const boardSnapshotSchema = z.object({
  asOf: iso,
  viewer: z.object({
    role: z.enum(APP_ROLES),
    partyId: z.uuid().nullable(),
    canPlan: z.boolean(),
  }),
  lanes: z.array(boardLaneSchema),
});
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

export const jobResponseSchema = z.object({ job: jobViewSchema });
export type JobResponse = z.infer<typeof jobResponseSchema>;

/** 409: the version was stale; `job` is the current one (as GET answers it). */
export const jobConflictResponseSchema = z.object({ error: z.string(), job: jobViewSchema });
export type JobConflictResponse = z.infer<typeof jobConflictResponseSchema>;

/** 422: a rule refused the write. */
export const JOB_RULE_REASONS = [
  'not_on_field',
  'not_allowed',
  'same',
  'machine_retired',
  'closed',
  'not_in_lane',
] as const;
export const jobRuleErrorSchema = z.object({
  error: z.string(),
  reason: z.enum(JOB_RULE_REASONS).optional(),
});
export type JobRuleError = z.infer<typeof jobRuleErrorSchema>;

/** Any other error body. */
export const apiErrorSchema = z.object({ error: z.string() });

/** GET /api/v1/crew: crew parties (role crew, kind person), by name. */
export const crewPersonSchema = z.object({
  partyId: z.uuid(),
  /** Null = no sign-in (the person can still be assigned). */
  appUserId: z.uuid().nullable(),
  name: z.string(),
  initials: z.string(),
  appRole: z.enum(APP_ROLES).nullable(),
  /** False when their sign-in is switched off. */
  active: z.boolean(),
});
export type CrewPerson = z.infer<typeof crewPersonSchema>;
export const crewResponseSchema = z.object({ people: z.array(crewPersonSchema) });
export type CrewResponse = z.infer<typeof crewResponseSchema>;

/** GET /api/v1/job-options: what the job form picks from (job-forms). */
export const jobOptionsResponseSchema = z.object({
  products: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(PRODUCT_KINDS),
      name: z.string(),
      unit: z.enum(PRODUCT_UNITS),
      epaRegNo: z.string().nullable(),
      restrictedUse: z.boolean(),
      active: z.boolean(),
    }),
  ),
  /**
   * Parties with role customer of either kind: orgs first, then persons (by name). `orgName`:
   * a person's org (`farm.parties.org_id`), as a hint ("Gail Pressler · Juniper Hill").
   */
  customers: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.enum(PARTY_KINDS),
      orgName: z.string().nullable(),
    }),
  ),
  fields: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      farmName: z.string().nullable(),
      acres: z.number().nullable(),
      customerId: z.uuid().nullable(),
    }),
  ),
  /** The crop seasons a job may name (cropSeasonsToSync(now), D23). */
  cropYears: z.array(z.number().int()),
  currentCropYear: z.number().int(),
});
export type JobOptionsResponse = z.infer<typeof jobOptionsResponseSchema>;

export const usageHeartbeatResponseSchema = z.object({ recorded: z.boolean() });
export type UsageHeartbeatResponse = z.infer<typeof usageHeartbeatResponseSchema>;
