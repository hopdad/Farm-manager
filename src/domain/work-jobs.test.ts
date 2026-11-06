/**
 * The job status machine (decision 2a-3, roles 2a-2; docs/contracts-2a.md §4.3): every (from,
 * to, role, ownJob, via) combination against a table written from the contract, the buttons it
 * yields, and the automatic moves. The foundation wrote it with the machine; jobs-api owns this
 * file from here (src/domain/work-jobs.ts bodies below "SIGNATURES FROZEN").
 */
import { describe, expect, test } from 'vitest';
import { APP_ROLES, type AppRole } from './farm';
import {
  autoJobStatus,
  checkJobTransition,
  JOB_KINDS,
  JOB_OPERATION_KIND,
  JOB_STATUSES,
  type JobActor,
  type JobStatus,
  nextJobStatuses,
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
