/**
 * The job status machine (decision 2a-3, roles 2a-2; docs/contracts-2a.md §4.3): every (from,
 * to, role, ownJob, via) combination against a table written from the contract, the buttons it
 * yields, and the automatic moves. The foundation wrote it with the machine; jobs-api owns this
 * file from here (src/domain/work-jobs.ts bodies below "SIGNATURES FROZEN") and adds the card's
 * summary, its conflict flags (contracts-2a §4.3, §4.5, decision 2a-5) and the small helpers.
 */
import { describe, expect, test } from 'vitest';
import { APP_ROLES, type AppRole } from './farm';
import {
  ACRES_DIFFER_FRACTION,
  type AssignmentRowLike,
  acresDiffer,
  assignmentRole,
  autoJobStatus,
  autoJobStatusAfter,
  checkJobTransition,
  formatJobAcres,
  formatJobQuantity,
  JOB_FLAGS,
  JOB_KINDS,
  JOB_OPERATION_KIND,
  JOB_STATUSES,
  type JobActor,
  type JobFlagInput,
  type JobStatus,
  jobFlags,
  jobSummary,
  nextJobStatuses,
  personInitials,
  planAssignment,
  planJobReorder,
  planUnassignment,
  type ReorderRow,
} from './work-jobs';

type Via = NonNullable<JobActor['via']>;
const VIAS: readonly Via[] = ['person', 'work_plan', 'billing'];

/** The contract's moves, each with the only `via` that makes it. */
const MOVES: Record<string, Via> = {
  'requested>planned': 'person',
  'assigned>pushed': 'work_plan',
  'assigned>in_progress': 'person',
  'pushed>in_progress': 'person',
  'in_progress>done': 'person',
  'done>in_progress': 'person',
  'done>invoiced': 'billing',
  'requested>cancelled': 'person',
  'planned>cancelled': 'person',
  'assigned>cancelled': 'person',
  'pushed>cancelled': 'person',
  'in_progress>cancelled': 'person',
};
/** What a driver or operator may do, on their own job only. */
const OWN = new Set(['assigned>in_progress', 'pushed>in_progress', 'in_progress>done']);

const rank = (r: AppRole) => APP_ROLES.indexOf(r);

/** The expected answer, from the contract's words (not from the implementation). */
function expected(
  from: JobStatus,
  to: JobStatus,
  who: Required<JobActor>,
): 'ok' | 'same' | 'not_allowed' | 'forbidden' {
  if (from === to) return 'same';
  const key = `${from}>${to}`;
  if (MOVES[key] !== who.via) return 'not_allowed';
  if (rank(who.role) >= rank('manager')) return 'ok';
  if (rank(who.role) >= rank('driver') && who.via === 'person' && OWN.has(key)) {
    return who.ownJob ? 'ok' : 'forbidden';
  }
  return 'forbidden';
}

describe('checkJobTransition', () => {
  test('every (from, to, role, ownJob, via) matches the contract', () => {
    let n = 0;
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        for (const role of APP_ROLES) {
          for (const ownJob of [false, true]) {
            for (const via of VIAS) {
              const got = checkJobTransition(from, to, { role, ownJob, via });
              const want = expected(from, to, { role, ownJob, via });
              const label = `${from} -> ${to} as ${role}${ownJob ? ' (own)' : ''} via ${via}`;
              expect(got.ok ? 'ok' : got.reason, label).toBe(want);
              if (!got.ok) expect(got.message.length, label).toBeGreaterThan(0);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(8 * 8 * 5 * 2 * 3);
  });

  test('via defaults to person', () => {
    const manager = { role: 'manager' as const, ownJob: false };
    expect(checkJobTransition('requested', 'planned', manager)).toEqual({ ok: true });
    expect(checkJobTransition('assigned', 'pushed', manager)).toMatchObject({
      ok: false,
      reason: 'not_allowed',
    });
  });

  test('the automatic moves are never a manual move; nothing goes back to requested', () => {
    for (const role of APP_ROLES) {
      const who = { role, ownJob: true };
      expect(checkJobTransition('planned', 'assigned', who)).toMatchObject({
        reason: 'not_allowed',
      });
      expect(checkJobTransition('assigned', 'planned', who)).toMatchObject({
        reason: 'not_allowed',
      });
      for (const from of JOB_STATUSES) {
        if (from === 'requested') continue;
        expect(checkJobTransition(from, 'requested', who).ok).toBe(false);
      }
    }
  });
});

describe('nextJobStatuses', () => {
  test('a manager: accept and cancel a request; start or cancel an assigned job; reopen a done one', () => {
    const m = { role: 'manager' as const, ownJob: false };
    expect(nextJobStatuses('requested', m)).toEqual(['planned', 'cancelled']);
    expect(nextJobStatuses('planned', m)).toEqual(['cancelled']);
    expect(nextJobStatuses('assigned', m)).toEqual(['in_progress', 'cancelled']);
    expect(nextJobStatuses('done', m)).toEqual(['in_progress']);
    expect(nextJobStatuses('cancelled', m)).toEqual([]);
    expect(nextJobStatuses('invoiced', m)).toEqual([]);
    expect(nextJobStatuses('assigned', { ...m, via: 'work_plan' })).toEqual(['pushed']);
    expect(nextJobStatuses('done', { ...m, via: 'billing' })).toEqual(['invoiced']);
  });

  test('a driver on their own job: start it, finish it; on another job or as a viewer: nothing', () => {
    const own = { role: 'driver' as const, ownJob: true };
    expect(nextJobStatuses('assigned', own)).toEqual(['in_progress']);
    expect(nextJobStatuses('pushed', own)).toEqual(['in_progress']);
    expect(nextJobStatuses('in_progress', own)).toEqual(['done']);
    expect(nextJobStatuses('done', own)).toEqual([]);
    expect(nextJobStatuses('assigned', { ...own, ownJob: false })).toEqual([]);
    for (const s of JOB_STATUSES) {
      expect(nextJobStatuses(s, { role: 'viewer', ownJob: true })).toEqual([]);
    }
  });

  test('always in JOB_STATUSES order and only moves checkJobTransition allows', () => {
    for (const from of JOB_STATUSES) {
      for (const role of APP_ROLES) {
        const who = { role, ownJob: true };
        const next = nextJobStatuses(from, who);
        expect(next).toEqual(JOB_STATUSES.filter((s) => next.includes(s)));
        for (const to of next) expect(checkJobTransition(from, to, who).ok).toBe(true);
      }
    }
  });
});

describe('autoJobStatus', () => {
  test('a field and an assignment make a requested or planned job assigned', () => {
    for (const s of ['requested', 'planned'] as const) {
      expect(autoJobStatus(s, { hasField: true, assignmentCount: 1 })).toBe('assigned');
      expect(autoJobStatus(s, { hasField: true, assignmentCount: 3 })).toBe('assigned');
      expect(autoJobStatus(s, { hasField: false, assignmentCount: 2 })).toBe(s);
      expect(autoJobStatus(s, { hasField: true, assignmentCount: 0 })).toBe(s);
    }
  });

  test('an assigned job that loses its last assignment goes back to planned; a lost field keeps it', () => {
    expect(autoJobStatus('assigned', { hasField: true, assignmentCount: 0 })).toBe('planned');
    expect(autoJobStatus('assigned', { hasField: false, assignmentCount: 0 })).toBe('planned');
    expect(autoJobStatus('assigned', { hasField: false, assignmentCount: 1 })).toBe('assigned');
  });

  test('every other status keeps itself', () => {
    for (const s of ['pushed', 'in_progress', 'done', 'invoiced', 'cancelled'] as const) {
      for (const hasField of [false, true]) {
        for (const assignmentCount of [0, 1]) {
          expect(autoJobStatus(s, { hasField, assignmentCount })).toBe(s);
        }
      }
    }
  });
});

describe('JOB_OPERATION_KIND', () => {
  test('field work maps to its Deere operation kind; the rest never gets a Work Plan', () => {
    expect(Object.keys(JOB_OPERATION_KIND).sort()).toEqual([...JOB_KINDS].sort());
    expect(JOB_OPERATION_KIND).toMatchObject({
      plant: 'seeding',
      spray: 'application',
      fertilize: 'application',
      harvest: 'harvest',
      tillage: 'tillage',
      haul: null,
      scout: null,
      tile: null,
      repair: null,
      other: null,
    });
  });
});

describe('autoJobStatusAfter', () => {
  test('says whether the automatic move changed the status', () => {
    expect(autoJobStatusAfter('planned', { hasField: true, assignmentCount: 1 })).toEqual({
      status: 'assigned',
      changed: true,
    });
    expect(autoJobStatusAfter('assigned', { hasField: false, assignmentCount: 1 })).toEqual({
      status: 'assigned',
      changed: false,
    });
    expect(autoJobStatusAfter('assigned', { hasField: true, assignmentCount: 0 })).toEqual({
      status: 'planned',
      changed: true,
    });
  });
});

describe('jobSummary', () => {
  const base = {
    kind: 'spray' as const,
    title: null,
    fieldName: 'Halvorsen Corwin 80',
    plannedAcres: 78.4,
    plannedQty: null,
    plannedUnit: null,
  };

  test('kind, field and acres (the contract example)', () => {
    expect(jobSummary(base)).toBe('Spray · Halvorsen Corwin 80 · 78 ac');
  });

  test('the title wins when there is one; a blank title does not', () => {
    expect(jobSummary({ ...base, title: 'Fungicide pass' })).toBe('Fungicide pass');
    expect(jobSummary({ ...base, title: '  Fungicide pass ' })).toBe('Fungicide pass');
    expect(jobSummary({ ...base, title: '   ' })).toBe('Spray · Halvorsen Corwin 80 · 78 ac');
  });

  test('no acres: the planned quantity and its unit', () => {
    expect(
      jobSummary({
        ...base,
        kind: 'haul',
        fieldName: null,
        plannedAcres: null,
        plannedQty: 14,
        plannedUnit: 'loads',
      }),
    ).toBe('Haul · 14 loads');
    expect(
      jobSummary({
        ...base,
        kind: 'harvest',
        plannedAcres: null,
        plannedQty: 12_000,
        plannedUnit: 'bu',
      }),
    ).toBe('Harvest · Halvorsen Corwin 80 · 12,000 bu');
    expect(
      jobSummary({ ...base, kind: 'other', fieldName: null, plannedAcres: null, plannedQty: 3 }),
    ).toBe('Other · 3');
  });

  test('acres come before a quantity; unknown parts are left out', () => {
    expect(jobSummary({ ...base, plannedQty: 900, plannedUnit: 'gal' })).toBe(
      'Spray · Halvorsen Corwin 80 · 78 ac',
    );
    expect(jobSummary({ ...base, fieldName: null, plannedAcres: null })).toBe('Spray');
    expect(jobSummary({ ...base, fieldName: '  ', plannedAcres: 4.46 })).toBe('Spray · 4.5 ac');
    for (const kind of JOB_KINDS) {
      expect(
        jobSummary({ ...base, kind, fieldName: null, plannedAcres: null }).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('formatJobAcres / formatJobQuantity', () => {
  test('whole acres from 10 up, one decimal below, grouped thousands', () => {
    expect(formatJobAcres(78.4)).toBe('78 ac');
    expect(formatJobAcres(78.5)).toBe('79 ac');
    expect(formatJobAcres(1234.4)).toBe('1,234 ac');
    expect(formatJobAcres(9.94)).toBe('9.9 ac');
    expect(formatJobAcres(0)).toBe('0 ac');
  });

  test('quantities keep up to two decimals and name their unit', () => {
    expect(formatJobQuantity(12_000, 'bu')).toBe('12,000 bu');
    expect(formatJobQuantity(2.5, 'hours')).toBe('2.5 hours');
    expect(formatJobQuantity(2_500, 'gal')).toBe('2,500 gal');
    expect(formatJobQuantity(7.125, 'tons')).toBe('7.13 tons');
    expect(formatJobQuantity(14, null)).toBe('14');
  });
});

describe('acresDiffer (decision 2a-5)', () => {
  test('more than 1 % of the boundary acres', () => {
    expect(ACRES_DIFFER_FRACTION).toBe(0.01);
    expect(acresDiffer(100, 100)).toBe(false);
    expect(acresDiffer(101, 100)).toBe(false);
    expect(acresDiffer(99, 100)).toBe(false);
    expect(acresDiffer(101.01, 100)).toBe(true);
    expect(acresDiffer(98.99, 100)).toBe(true);
    expect(acresDiffer(80, 78.4)).toBe(true);
  });

  test('unknown on either side never differs; a zero-acre boundary differs from any acres', () => {
    expect(acresDiffer(null, 100)).toBe(false);
    expect(acresDiffer(100, null)).toBe(false);
    expect(acresDiffer(null, null)).toBe(false);
    expect(acresDiffer(Number.NaN, 100)).toBe(false);
    expect(acresDiffer(0, 0)).toBe(false);
    expect(acresDiffer(5, 0)).toBe(true);
  });
});

describe('jobFlags', () => {
  const clean: JobFlagInput = {
    hasField: true,
    plannedAcres: 160,
    boundaryAcres: 160,
    machinesDown: 0,
    overlaps: 0,
    restrictedUse: false,
  };

  test('a job with nothing wrong has no flags', () => {
    expect(jobFlags(clean)).toEqual([]);
  });

  test('each condition raises its own flag', () => {
    expect(jobFlags({ ...clean, hasField: false, boundaryAcres: null })).toEqual(['no_field']);
    expect(jobFlags({ ...clean, machinesDown: 1 })).toEqual(['machine_down']);
    expect(jobFlags({ ...clean, overlaps: 2 })).toEqual(['double_booked']);
    expect(jobFlags({ ...clean, plannedAcres: 150 })).toEqual(['acres_differ']);
    expect(jobFlags({ ...clean, plannedAcres: 161.5 })).toEqual([]);
    expect(jobFlags({ ...clean, restrictedUse: true })).toEqual(['restricted_use']);
  });

  test('a field cleared from an assigned job: no_field, and no acres comparison without a boundary', () => {
    expect(jobFlags({ ...clean, hasField: false, plannedAcres: 160, boundaryAcres: null })).toEqual(
      ['no_field'],
    );
  });

  test('all of them at once, in JOB_FLAGS order', () => {
    expect(
      jobFlags({
        hasField: false,
        plannedAcres: 10,
        boundaryAcres: 20,
        machinesDown: 2,
        overlaps: 1,
        restrictedUse: true,
      }),
    ).toEqual([...JOB_FLAGS]);
  });
});

describe('personInitials', () => {
  test('first and last word, or the first two letters of one word', () => {
    expect(personInitials('Dale Mercer')).toBe('DM');
    expect(personInitials('Mary Ann de Vries')).toBe('MV');
    expect(personInitials('amy')).toBe('AM');
    expect(personInitials('E2E Manager')).toBe('EM');
    expect(personInitials('  Luis   Ortega ')).toBe('LO');
    expect(personInitials("Kyle O'Dunleavy")).toBe('KD');
    expect(personInitials('Ébène Ödegaard')).toBe('ÉÖ');
    expect(personInitials('J')).toBe('J');
    expect(personInitials('---')).toBe('?');
    expect(personInitials('')).toBe('?');
  });
});

describe('planAssignment (decision 2a-4)', () => {
  const row = (
    id: string,
    machineId: string | null,
    partyId: string | null,
  ): AssignmentRowLike => ({
    id,
    machineId,
    partyId,
  });

  test('onto an empty job: a new row, operator with a machine, crew without', () => {
    expect(planAssignment([], { machineId: 'm1' })).toEqual({
      changes: [{ op: 'insert', machineId: 'm1', partyId: null, role: 'operator' }],
      count: 1,
    });
    expect(planAssignment([], { partyId: 'p1' })).toEqual({
      changes: [{ op: 'insert', machineId: null, partyId: 'p1', role: 'crew' }],
      count: 1,
    });
    expect(planAssignment([], { machineId: 'm1', partyId: 'p1' })).toEqual({
      changes: [{ op: 'insert', machineId: 'm1', partyId: 'p1', role: 'operator' }],
      count: 1,
    });
  });

  test('a machine fills the oldest row with a person and no machine (SP2 then Dale is one row)', () => {
    const rows = [row('a', 'm9', 'p9'), row('b', null, 'p1'), row('c', null, 'p2')];
    expect(planAssignment(rows, { machineId: 'm1' })).toEqual({
      changes: [{ op: 'update', id: 'b', machineId: 'm1', partyId: 'p1', role: 'operator' }],
      count: 3,
    });
  });

  test('a person fills the oldest row with a machine and no person', () => {
    const rows = [row('a', 'm1', 'p1'), row('b', 'm2', null), row('c', 'm3', null)];
    expect(planAssignment(rows, { partyId: 'p2' })).toEqual({
      changes: [{ op: 'update', id: 'b', machineId: 'm2', partyId: 'p2', role: 'operator' }],
      count: 3,
    });
  });

  test('a second machine makes a second row; a second person too', () => {
    const rows = [row('a', 'm1', 'p1')];
    expect(planAssignment(rows, { machineId: 'm2' }).changes).toEqual([
      { op: 'insert', machineId: 'm2', partyId: null, role: 'operator' },
    ]);
    expect(planAssignment(rows, { partyId: 'p2' }).changes).toEqual([
      { op: 'insert', machineId: null, partyId: 'p2', role: 'crew' },
    ]);
  });

  test('already on the job: nothing to write', () => {
    const rows = [row('a', 'm1', 'p1'), row('b', 'm2', null)];
    expect(planAssignment(rows, { machineId: 'm1' })).toEqual({ changes: [], count: 2 });
    expect(planAssignment(rows, { partyId: 'p1' })).toEqual({ changes: [], count: 2 });
    expect(planAssignment(rows, { machineId: 'm2', partyId: 'p1' })).toEqual({
      changes: [],
      count: 2,
    });
  });

  test('both at once: the person joins the machine on its row when it has no one', () => {
    // The machine is already on a row with nobody: the person goes there.
    expect(
      planAssignment([row('a', 'm1', null)], { machineId: 'm1', partyId: 'p1' }).changes,
    ).toEqual([{ op: 'update', id: 'a', machineId: 'm1', partyId: 'p1', role: 'operator' }]);
    // The person is on a row with no machine: the machine goes to that row (not the oldest).
    const rows = [row('a', null, 'p0'), row('b', null, 'p1')];
    expect(planAssignment(rows, { machineId: 'm1', partyId: 'p1' }).changes).toEqual([
      { op: 'update', id: 'b', machineId: 'm1', partyId: 'p1', role: 'operator' },
    ]);
    // The machine's row has someone else: the person fills the next machine-only row or a new one.
    const busy = [row('a', 'm1', 'p0'), row('b', 'm2', null)];
    expect(planAssignment(busy, { machineId: 'm1', partyId: 'p1' }).changes).toEqual([
      { op: 'update', id: 'b', machineId: 'm2', partyId: 'p1', role: 'operator' },
    ]);
  });

  test('assignmentRole', () => {
    expect(assignmentRole({ machineId: 'm' })).toBe('operator');
    expect(assignmentRole({ machineId: null })).toBe('crew');
  });
});

describe('planUnassignment', () => {
  const rows: AssignmentRowLike[] = [
    { id: 'a', machineId: 'm1', partyId: 'p1' },
    { id: 'b', machineId: 'm2', partyId: null },
    { id: 'c', machineId: null, partyId: 'p3' },
  ];

  test('the whole row', () => {
    expect(planUnassignment(rows, 'a')).toEqual({ changes: [{ op: 'delete', id: 'a' }], count: 2 });
  });

  test('one side: the row stays with the other (its role follows the machine)', () => {
    expect(planUnassignment(rows, 'a', 'machine')).toEqual({
      changes: [{ op: 'update', id: 'a', machineId: null, partyId: 'p1', role: 'crew' }],
      count: 3,
    });
    expect(planUnassignment(rows, 'a', 'person')).toEqual({
      changes: [{ op: 'update', id: 'a', machineId: 'm1', partyId: null, role: 'operator' }],
      count: 3,
    });
  });

  test('a row left with neither is deleted; a side it has not got changes nothing', () => {
    expect(planUnassignment(rows, 'b', 'machine')).toEqual({
      changes: [{ op: 'delete', id: 'b' }],
      count: 2,
    });
    expect(planUnassignment(rows, 'c', 'person')).toEqual({
      changes: [{ op: 'delete', id: 'c' }],
      count: 2,
    });
    expect(planUnassignment(rows, 'b', 'person')).toEqual({ changes: [], count: 3 });
    expect(planUnassignment(rows, 'c', 'machine')).toEqual({ changes: [], count: 3 });
  });

  test('not on this job: null', () => {
    expect(planUnassignment(rows, 'zz')).toBeNull();
  });
});

describe('planJobReorder (decision 2a-1)', () => {
  const r = (id: string, over: Partial<ReorderRow> = {}): ReorderRow => ({
    id,
    version: 1,
    status: 'planned',
    businessLine: 'spraying',
    priority: 3,
    sortKey: 10,
    createdAt: 0,
    ...over,
  });
  const v1 = (...ids: string[]) => ids.map((id) => ({ id, version: 1 }));

  test('sort_key = (position + 1) × 10, only the jobs that move', () => {
    const rows = [r('a', { sortKey: 10 }), r('b', { sortKey: 20 }), r('c', { sortKey: 30 })];
    expect(planJobReorder('spraying', v1('b', 'a', 'c'), rows)).toEqual({
      ok: true,
      changes: [
        { id: 'b', sortKey: 10 },
        { id: 'a', sortKey: 20 },
      ],
    });
    expect(planJobReorder('spraying', v1('a', 'b', 'c'), rows)).toEqual({ ok: true, changes: [] });
  });

  test('refusals in order: stale first, then not in the lane, then a missing open job', () => {
    const rows = [
      r('a'),
      r('b', { version: 2 }),
      r('x', { businessLine: 'grain' }),
      r('d', { status: 'done' }),
    ];
    expect(planJobReorder('spraying', v1('x', 'a', 'b'), rows)).toEqual({
      ok: false,
      reason: 'stale',
      jobId: 'b',
    });
    expect(
      planJobReorder('spraying', v1('a', 'x'), [r('a'), r('x', { businessLine: 'grain' })]),
    ).toEqual({
      ok: false,
      reason: 'not_in_lane',
      jobId: 'x',
    });
    expect(
      planJobReorder('spraying', v1('a', 'd'), [r('a'), r('d', { status: 'done' })]),
    ).toMatchObject({
      reason: 'not_in_lane',
      jobId: 'd',
    });
    expect(planJobReorder('spraying', v1('a', 'gone'), [r('a')])).toMatchObject({
      reason: 'not_in_lane',
      jobId: 'gone',
    });
    // Two missing: the first in lane order (priority, sort key, created) is named.
    const lane = [
      r('a'),
      r('late', { priority: 3, sortKey: 50 }),
      r('urgent', { priority: 1, sortKey: 90 }),
    ];
    expect(planJobReorder('spraying', v1('a'), lane)).toEqual({
      ok: false,
      reason: 'missing',
      jobId: 'urgent',
    });
  });
});
