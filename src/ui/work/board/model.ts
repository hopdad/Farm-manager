/**
 * The job board's view model (pure; unit-tested in ./model.test.ts): what a card, a chip and the
 * job detail show, which status buttons and moves a viewer gets, and how a job the server just
 * answered is merged into the board's snapshot. No React, no DOM, no fetch.
 *
 * Every value comes from the API's views (src/ui/work/contract.ts): the board shows the flags
 * and `alsoOn` the server computes (jobs-api, contracts-2a §4.5) and never invents its own.
 */
import { FARM_TIME_ZONE, farmDate } from '../../../domain/farm';
import {
  ACRES_DIFFER_FRACTION,
  BUSINESS_LINES,
  type BusinessLine,
  isOpenJobStatus,
  JOB_FLAGS,
  JOB_OPERATION_KIND,
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
  type JobFlag,
  type JobPriority,
  type JobStatus,
  nextJobStatuses,
} from '../../../domain/work-jobs';
import { ROLE_FOR, type Role, roleAtLeast } from '../../../platform/auth/types';
import type { PanelMachine } from '../../fleet/contract';
import type {
  BoardLane,
  BoardSnapshot,
  CrewPerson,
  JobAssignmentView,
  JobView,
  JobWindow,
} from '../contract';
import { laneLabel } from '../style';

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** What a card's flag tag says (JOB_FLAGS order). */
export const FLAG_LABELS: Record<JobFlag, string> = {
  no_field: 'No field yet',
  machine_down: 'Machine down',
  double_booked: 'Double-booked',
  acres_differ: 'Acres differ',
  restricted_use: 'Restricted use',
};

/** Flags that need someone's attention before the job runs (a warning colour). */
export const WARNING_FLAGS: ReadonlySet<JobFlag> = new Set([
  'machine_down',
  'double_booked',
  'restricted_use',
]);

/** ICU puts narrow no-break spaces into times; keep plain spaces (as the status strip does). */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: FARM_TIME_ZONE, weekday: 'short' });
const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  month: 'short',
  day: 'numeric',
});

const DAY_MS = 86_400_000;

/** Whole farm days from `now`'s farm day to `at`'s (America/Detroit calendar days). */
function farmDayOffset(at: Date, now: Date): number {
  const a = Date.parse(`${farmDate(at)}T00:00:00Z`);
  const b = Date.parse(`${farmDate(now)}T00:00:00Z`);
  return Math.round((a - b) / DAY_MS);
}

/** "Today", "Tomorrow", "Yesterday", "Fri" (this week), "Nov 14" (further). */
export function formatDay(at: Date, now: Date): string {
  const d = farmDayOffset(at, now);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return weekdayFmt.format(at);
  return dayFmt.format(at);
}

/** "8:00 AM"; compact: "8 AM" on the hour (a card's narrow line). */
export function formatTime(at: Date, compact = false): string {
  const t = plain(timeFmt.format(at));
  return compact ? t.replace(/:00 /, ' ') : t;
}

/**
 * A job's window as the card shows it (America/Detroit): "Today 8:00 AM–5:00 PM",
 * "Today 8:00 AM – Tomorrow 7:00 PM", "From Fri 9:00 AM", "Until Nov 14 5:00 PM"; null when the
 * job has no window ("No window": decision 2a-1, the window is shown, never sorted by).
 */
export function formatWindow(
  window: JobWindow | null,
  now: Date,
  opts: { compact?: boolean } = {},
): string | null {
  if (!window || (window.from === null && window.to === null)) return null;
  const c = opts.compact === true;
  const from = window.from === null ? null : new Date(window.from);
  const to = window.to === null ? null : new Date(window.to);
  if (from && to) {
    const sameDay = farmDate(from) === farmDate(to);
    // [from, to): a window that ends at midnight is that day's.
    const endsAtMidnight = farmDate(new Date(to.getTime() - 1)) === farmDate(from);
    if (sameDay || (endsAtMidnight && formatTime(to) === '12:00 AM')) {
      return `${formatDay(from, now)} ${formatTime(from, c)}–${formatTime(to, c)}`;
    }
    return `${formatDay(from, now)} ${formatTime(from, c)} – ${formatDay(to, now)} ${formatTime(to, c)}`;
  }
  if (from) return `From ${formatDay(from, now)} ${formatTime(from, c)}`;
  return `Until ${formatDay(to as Date, now)} ${formatTime(to as Date, c)}`;
}

/** "78 ac", "78.5 ac" (one decimal only when it isn't whole). */
export function formatAcres(acres: number | null): string | null {
  if (acres === null || !Number.isFinite(acres)) return null;
  const rounded = Math.round(acres * 10) / 10;
  return `${rounded.toLocaleString('en-US', { maximumFractionDigits: 1 })} ac`;
}

/** Planned acres differ from the boundary's by more than ACRES_DIFFER_FRACTION (2a-5). */
export function acresDiffer(planned: number | null, boundary: number | null): boolean {
  if (planned === null || boundary === null || boundary <= 0) return false;
  return Math.abs(planned - boundary) > ACRES_DIFFER_FRACTION * boundary;
}

/**
 * The acres line: the planned acres, with the boundary's beside them when they differ by more
 * than 1 % (decision 2a-5: later boundary changes don't move a job's acres); a planned quantity
 * when the job has one ("14 loads").
 */
export function acresText(job: JobView): string | null {
  const parts: string[] = [];
  const planned = formatAcres(job.plannedAcres);
  const boundary = job.field?.boundaryAcres ?? null;
  if (planned) {
    parts.push(
      acresDiffer(job.plannedAcres, boundary)
        ? `${planned} (boundary ${formatAcres(boundary)})`
        : planned,
    );
  } else if (boundary !== null) {
    parts.push(formatAcres(boundary) as string);
  }
  if (job.plannedQty !== null) {
    const qty = job.plannedQty.toLocaleString('en-US', { maximumFractionDigits: 2 });
    parts.push(job.plannedUnit ? `${qty} ${job.plannedUnit}` : qty);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** "Glyphosate, 2,4-D" (the job's products by name), null with none. */
export function productsText(job: JobView): string | null {
  return job.products.length ? job.products.map((p) => p.name).join(', ') : null;
}

/** The chip on a card: "SP2 · Dale Mercer", "SP2", "Dale Mercer". */
export function assignmentLabel(a: JobAssignmentView): string {
  const parts = [a.machine?.unitNo, a.person?.name].filter((x): x is string => !!x);
  return parts.join(' · ');
}

/**
 * The machine's "Deere" badge on a CARD: only when the job can become a Work Plan
 * (JOB_OPERATION_KIND[kind] set: plant, spray, fertilize, harvest, tillage) and the machine can
 * take one (decision 2a-13, contracts-2a §5.6). The chips tray shows it from the machine alone.
 */
export function showDeereBadge(job: Pick<JobView, 'kind'>, a: JobAssignmentView): boolean {
  return JOB_OPERATION_KIND[job.kind] !== null && a.machine?.workPlanCapable === true;
}

/** The flags in JOB_FLAGS order, deduplicated (the server sends them in order already). */
export function orderedFlags(flags: readonly JobFlag[]): JobFlag[] {
  return JOB_FLAGS.filter((f) => flags.includes(f));
}

export interface CardView {
  summary: string;
  status: JobStatus;
  statusLabel: string;
  /** "Urgent" / "High" for priorities 1 and 2 (normal and low say nothing). */
  priorityLabel: string | null;
  fieldName: string | null;
  acres: string | null;
  window: string | null;
  products: string | null;
  flags: JobFlag[];
  assignments: {
    id: string;
    label: string;
    machineId: string | null;
    partyId: string | null;
    deere: boolean;
    down: boolean;
  }[];
  /** Open jobs can be dragged (by a planner); a done card stays where it is. */
  open: boolean;
}

export function cardView(job: JobView, now: Date, opts: { compact?: boolean } = {}): CardView {
  return {
    summary: job.summary || job.title || '',
    status: job.status,
    statusLabel: JOB_STATUS_LABELS[job.status],
    priorityLabel: job.priority <= 2 ? JOB_PRIORITY_LABELS[job.priority as JobPriority] : null,
    fieldName: job.field?.name ?? null,
    acres: acresText(job),
    window: formatWindow(job.window, now, opts),
    products: productsText(job),
    flags: orderedFlags(job.flags),
    assignments: job.assignments.map((a) => ({
      id: a.id,
      label: assignmentLabel(a),
      machineId: a.machine?.id ?? null,
      partyId: a.person?.partyId ?? null,
      deere: showDeereBadge(job, a),
      down: a.machine?.status === 'down',
    })),
    open: isOpenJobStatus(job.status),
  };
}

// ---------------------------------------------------------------------------------------------
// Who may do what (UI hints only: the server re-checks every write, contracts-2a §2)
// ---------------------------------------------------------------------------------------------

export interface BoardViewer {
  role: Role;
  partyId: string | null;
  canPlan: boolean;
}

export const SIGNED_OUT_VIEWER: BoardViewer = { role: 'viewer', partyId: null, canPlan: false };

/** The session's party is on one of the job's assignments (a device-only session: never). */
export function isOwnJob(job: Pick<JobView, 'assignments'>, partyId: string | null): boolean {
  return partyId !== null && job.assignments.some((a) => a.person?.partyId === partyId);
}

export function canPlan(viewer: BoardViewer): boolean {
  return viewer.canPlan && roleAtLeast(viewer.role, ROLE_FOR.planJobs);
}

export interface StatusActions {
  /** Status buttons in JOB_STATUSES order (never `cancelled`: that is the Cancel button). */
  statuses: JobStatus[];
  canCancel: boolean;
}

/**
 * The job detail's buttons (decision 2a-2/2a-3): the machine's moves for this viewer
 * (nextJobStatuses, src/domain/work-jobs.ts); `cancelled` is the Cancel button (it posts to
 * …/cancel with the reason), the rest are status buttons.
 */
export function statusActions(job: JobView, viewer: BoardViewer): StatusActions {
  const next = nextJobStatuses(job.status, {
    role: viewer.role,
    ownJob: isOwnJob(job, viewer.partyId),
  });
  return {
    statuses: next.filter((s) => s !== 'cancelled'),
    canCancel: next.includes('cancelled'),
  };
}

/** A status button's words for this move. */
export function statusActionLabel(from: JobStatus, to: JobStatus): string {
  if (to === 'planned' && from === 'requested') return 'Accept request';
  if (to === 'in_progress') return from === 'done' ? 'Not done: back to in progress' : 'Start';
  if (to === 'done') return 'Mark done';
  return JOB_STATUS_LABELS[to];
}

// ---------------------------------------------------------------------------------------------
// Lanes and the snapshot
// ---------------------------------------------------------------------------------------------

/** The lane order of the snapshot query (contracts-2a §5.2): open by priority, sort_key, created. */
export function compareOpen(a: JobView, b: JobView): number {
  return (
    a.priority - b.priority ||
    a.sortKey - b.sortKey ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Open jobs in lane order, then the day's done jobs by when they went done. */
export function sortLaneJobs(jobs: readonly JobView[]): JobView[] {
  const open = jobs.filter((j) => isOpenJobStatus(j.status)).sort(compareOpen);
  const done = jobs
    .filter((j) => !isOpenJobStatus(j.status))
    .sort((a, b) => Date.parse(a.statusChangedAt) - Date.parse(b.statusChangedAt));
  return [...open, ...done];
}

/** Always the four lanes, in BUSINESS_LINES order (a snapshot missing one gets it empty). */
export function normalizeLanes(lanes: readonly BoardLane[]): BoardLane[] {
  return BUSINESS_LINES.map((line) => {
    const lane = lanes.find((l) => l.businessLine === line);
    return lane ?? { businessLine: line, label: laneLabel(line), jobs: [] };
  });
}

export function allJobs(snapshot: BoardSnapshot | null): JobView[] {
  return snapshot ? snapshot.lanes.flatMap((l) => l.jobs) : [];
}

export function findJob(snapshot: BoardSnapshot | null, jobId: string): JobView | null {
  if (!snapshot) return null;
  for (const lane of snapshot.lanes) {
    const job = lane.jobs.find((j) => j.id === jobId);
    if (job) return job;
  }
  return null;
}

export function laneOf(snapshot: BoardSnapshot | null, line: BusinessLine): BoardLane | null {
  return snapshot?.lanes.find((l) => l.businessLine === line) ?? null;
}

/**
 * Put the job the server just answered into the snapshot, at once (the realtime refetch that
 * follows brings the server's exact order): in place when it stays in its lane; at the end of
 * its priority when it moved lanes (the server gives a moved job the lane's largest sort_key +
 * 10); removed when it is closed and not a done job (cancelled, invoiced).
 */
export function mergeJob(snapshot: BoardSnapshot, job: JobView): BoardSnapshot {
  const keep = isOpenJobStatus(job.status) || job.status === 'done';
  const lanes = snapshot.lanes.map((lane) => {
    const had = lane.jobs.some((j) => j.id === job.id);
    const belongs = keep && lane.businessLine === job.businessLine;
    if (!had && !belongs) return lane;
    let jobs = lane.jobs.filter((j) => j.id !== job.id);
    if (belongs) {
      const placed =
        had || !isOpenJobStatus(job.status)
          ? job
          : { ...job, sortKey: Math.max(job.sortKey, ...jobs.map((j) => j.sortKey + 10)) };
      jobs = sortLaneJobs([...jobs, placed]);
    }
    return { ...lane, jobs };
  });
  return { ...snapshot, lanes };
}

/**
 * A fetched snapshot, keeping the jobs this screen has already seen NEWER (a write's answer
 * applied while an older fetch was in flight): a job whose version in the snapshot is below
 * `minVersions` keeps the local copy until a fetch catches up.
 */
export function reconcileSnapshot(
  fetched: BoardSnapshot,
  local: BoardSnapshot | null,
  minVersions: ReadonlyMap<string, number>,
): BoardSnapshot {
  if (!local || minVersions.size === 0) return { ...fetched, lanes: normalizeLanes(fetched.lanes) };
  let out: BoardSnapshot = { ...fetched, lanes: normalizeLanes(fetched.lanes) };
  for (const [id, min] of minVersions) {
    const there = findJob(out, id);
    if (there && there.version < min) {
      const mine = findJob(local, id);
      if (mine && mine.version >= min) out = mergeJob(out, mine);
    }
  }
  return out;
}

/** Counts for the collapsed bar and the pill: open jobs, requested ones, per lane. */
export function boardCounts(snapshot: BoardSnapshot | null): {
  open: number;
  requested: number;
  lanes: { businessLine: BusinessLine; label: string; open: number }[];
} {
  const lanes = normalizeLanes(snapshot?.lanes ?? []).map((l) => ({
    businessLine: l.businessLine,
    label: l.label,
    open: l.jobs.filter((j) => isOpenJobStatus(j.status)).length,
  }));
  const jobs = allJobs(snapshot);
  return {
    open: lanes.reduce((n, l) => n + l.open, 0),
    requested: jobs.filter((j) => j.status === 'requested').length,
    lanes,
  };
}

// ---------------------------------------------------------------------------------------------
// Move up / Move down (decision 2a-1, contracts-2a §7.1)
// ---------------------------------------------------------------------------------------------

export interface MoveOptions {
  up: boolean;
  down: boolean;
  /** Why a direction is off: the edge of the card's priority (change the priority to go on). */
  hint: string | null;
}

/**
 * Whether the card can swap with its neighbour OF THE SAME PRIORITY above / below it in its
 * lane's open jobs (a move across priorities is an Edit: reorder never changes a priority).
 */
export function moveOptions(lane: BoardLane | null, jobId: string): MoveOptions {
  const open = (lane?.jobs ?? []).filter((j) => isOpenJobStatus(j.status));
  const i = open.findIndex((j) => j.id === jobId);
  const job = open[i];
  if (!job) return { up: false, down: false, hint: null };
  const up = open[i - 1]?.priority === job.priority;
  const down = open[i + 1]?.priority === job.priority;
  const hint =
    up && down
      ? null
      : 'Change the priority (Edit) to move it further than the other ' +
        `${JOB_PRIORITY_LABELS[job.priority as JobPriority].toLowerCase()} jobs`;
  return { up, down, hint };
}

/**
 * The reorder body's job list (contracts-2a §5.2): EVERY open job of the lane, in the new order
 * (the card swapped with its same-priority neighbour), each with the version this screen saw.
 * Null when the move isn't possible.
 */
export function reorderedLane(
  lane: BoardLane | null,
  jobId: string,
  direction: 'up' | 'down',
): { id: string; version: number }[] | null {
  const opts = moveOptions(lane, jobId);
  if (!(direction === 'up' ? opts.up : opts.down)) return null;
  const open = (lane?.jobs ?? []).filter((j) => isOpenJobStatus(j.status));
  const i = open.findIndex((j) => j.id === jobId);
  const j = direction === 'up' ? i - 1 : i + 1;
  const order = [...open];
  [order[i], order[j]] = [order[j] as JobView, order[i] as JobView];
  return order.map((x) => ({ id: x.id, version: x.version }));
}

// ---------------------------------------------------------------------------------------------
// Chips tray
// ---------------------------------------------------------------------------------------------

/** "SP2" < "SP10": unit numbers in natural order. */
const natural = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

export interface MachineChip {
  id: string;
  unitNo: string;
  kind: PanelMachine['kind'];
  status: PanelMachine['status'];
  /** The "Deere" badge (decision 2a-13): from the machine alone in the tray. */
  workPlanCapable: boolean;
}

/** Non-retired machines of the fleet panel's shared feed, by unit number. */
export function machineChips(machines: readonly PanelMachine[]): MachineChip[] {
  return machines
    .filter((m) => m.status !== 'retired')
    .map((m) => ({
      id: m.id,
      unitNo: m.unitNo,
      kind: m.kind,
      status: m.status,
      workPlanCapable: m.workPlanCapable === true,
    }))
    .sort((a, b) => natural.compare(a.unitNo, b.unitNo) || (a.id < b.id ? -1 : 1));
}

export interface PersonChip {
  partyId: string;
  name: string;
  initials: string;
  /** Their sign-in is switched off (they can still be put on a job). */
  inactive: boolean;
}

/** Crew people (GET /api/v1/crew, by name); first name on the chip, the full name in its title. */
export function personChips(crew: readonly CrewPerson[]): PersonChip[] {
  return crew.map((p) => ({
    partyId: p.partyId,
    name: p.name,
    initials: p.initials || initialsOf(p.name),
    inactive: !p.active,
  }));
}

/** "DM" for Dale Mercer (when the server sends none). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : (words[0]?.[1] ?? '');
  return `${first}${last}`.toUpperCase();
}
