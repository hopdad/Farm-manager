import { describe, expect, test } from 'vitest';
import type { PanelMachine } from '../../fleet/contract';
import type { BoardSnapshot, CrewPerson, JobAssignmentView, JobView } from '../contract';
import {
  acresDiffer,
  acresText,
  assignmentLabel,
  boardCounts,
  canPlan,
  cardView,
  findJob,
  formatAcres,
  formatWindow,
  initialsOf,
  isOwnJob,
  machineChips,
  mergeJob,
  moveOptions,
  normalizeLanes,
  personChips,
  reconcileSnapshot,
  reorderedLane,
  showDeereBadge,
  sortLaneJobs,
  statusActionLabel,
  statusActions,
} from './model';
import { makeJobView } from './testkit';

// 2026-11-06 is a Friday; noon in Michigan (EST, UTC-5).
const NOW = new Date('2026-11-06T17:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = (n: number, p: Partial<JobView> = {}) =>
  makeJobView({ id: id(n), kind: 'spray', ...p }, NOW);

const machine = (n: number, p: Partial<NonNullable<JobAssignmentView['machine']>> = {}) => ({
  id: id(100 + n),
  unitNo: `SP${n}`,
  kind: 'sprayer' as const,
  status: 'active' as const,
  workPlanCapable: false,
  ...p,
});
const person = (n: number, name = 'Dale Mercer') => ({
  partyId: id(200 + n),
  name,
  initials: 'DM',
});
const row = (n: number, p: Partial<JobAssignmentView> = {}): JobAssignmentView => ({
  id: id(300 + n),
  role: 'operator',
  machine: null,
  person: null,
  plannedFor: null,
  alsoOn: [],
  ...p,
});

function snapshot(jobs: JobView[], viewer: Partial<BoardSnapshot['viewer']> = {}): BoardSnapshot {
  return {
    asOf: NOW.toISOString(),
    viewer: { role: 'manager', partyId: null, canPlan: true, ...viewer },
    lanes: normalizeLanes([]).map((l) => ({
      ...l,
      jobs: sortLaneJobs(jobs.filter((j) => j.businessLine === l.businessLine)),
    })),
  };
}

describe('text', () => {
  test('windows in farm time, relative to today', () => {
    expect(formatWindow({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T22:00:00Z' }, NOW)).toBe(
      'Today 8:00 AM–5:00 PM',
    );
    expect(formatWindow({ from: '2026-11-07T14:00:00Z', to: '2026-11-07T20:00:00Z' }, NOW)).toBe(
      'Tomorrow 9:00 AM–3:00 PM',
    );
    expect(formatWindow({ from: '2026-11-06T13:00:00Z', to: '2026-11-08T00:00:00Z' }, NOW)).toBe(
      'Today 8:00 AM – Tomorrow 7:00 PM',
    );
    expect(formatWindow({ from: '2026-11-06T13:00:00Z', to: '2026-11-09T00:00:00Z' }, NOW)).toBe(
      'Today 8:00 AM – Sun 7:00 PM',
    );
    expect(formatWindow({ from: '2026-11-09T15:00:00Z', to: null }, NOW)).toBe('From Mon 10:00 AM');
    expect(formatWindow({ from: null, to: '2026-11-20T22:00:00Z' }, NOW)).toBe(
      'Until Nov 20 5:00 PM',
    );
    expect(
      formatWindow({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T22:30:00Z' }, NOW, {
        compact: true,
      }),
    ).toBe('Today 8 AM–5:30 PM');
    expect(formatWindow(null, NOW)).toBeNull();
    expect(formatWindow({ from: null, to: null }, NOW)).toBeNull();
    // A window that ends at midnight is that day's.
    expect(formatWindow({ from: '2026-11-06T13:00:00Z', to: '2026-11-07T05:00:00Z' }, NOW)).toBe(
      'Today 8:00 AM–12:00 AM',
    );
  });

  test('acres: planned, and the boundary beside them past 1 %', () => {
    expect(formatAcres(78)).toBe('78 ac');
    expect(formatAcres(78.25)).toBe('78.3 ac');
    expect(formatAcres(null)).toBeNull();
    expect(acresDiffer(78, 78.5)).toBe(false);
    expect(acresDiffer(78, 80)).toBe(true);
    expect(acresDiffer(null, 80)).toBe(false);
    const field = { id: id(9), name: 'Corwin 80', farmName: 'Halvorsen', boundaryAcres: 80 };
    expect(acresText(job(1, { field, plannedAcres: 78 }))).toBe('78 ac (boundary 80 ac)');
    expect(acresText(job(1, { field, plannedAcres: 79.6 }))).toBe('79.6 ac');
    expect(acresText(job(1, { field }))).toBe('80 ac');
    expect(acresText(job(1, { plannedQty: 14, plannedUnit: 'loads' }))).toBe('14 loads');
    expect(acresText(job(1))).toBeNull();
  });

  test('assignment chips and the Deere badge only for kinds that become a Work Plan', () => {
    const both = row(1, { machine: machine(2, { workPlanCapable: true }), person: person(1) });
    expect(assignmentLabel(both)).toBe('SP2 · Dale Mercer');
    expect(assignmentLabel(row(2, { machine: machine(2) }))).toBe('SP2');
    expect(assignmentLabel(row(3, { person: person(1) }))).toBe('Dale Mercer');
    expect(showDeereBadge({ kind: 'spray' }, both)).toBe(true);
    expect(showDeereBadge({ kind: 'haul' }, both)).toBe(false);
    expect(showDeereBadge({ kind: 'repair' }, both)).toBe(false);
    expect(showDeereBadge({ kind: 'spray' }, row(4, { machine: machine(2) }))).toBe(false);
  });

  test('the card view', () => {
    const v = cardView(
      job(1, {
        title: 'Fungicide pass',
        status: 'requested',
        priority: 1,
        flags: ['restricted_use', 'no_field'],
        products: [
          {
            id: id(50),
            productId: id(51),
            name: 'Glyphosate',
            kind: 'chemical',
            rate: 32,
            unit: 'floz_ac',
            suppliedBy: 'us',
            restrictedUse: false,
            epaRegNo: null,
          },
        ],
        assignments: [row(1, { machine: machine(2, { status: 'down' }) })],
      }),
      NOW,
    );
    expect(v).toMatchObject({
      summary: 'Fungicide pass',
      statusLabel: 'Requested',
      priorityLabel: 'Urgent',
      fieldName: null,
      products: 'Glyphosate',
      flags: ['no_field', 'restricted_use'],
      open: true,
    });
    expect(v.assignments[0]).toMatchObject({ label: 'SP2', down: true, deere: false });
    expect(cardView(job(2, { status: 'done', priority: 3 }), NOW)).toMatchObject({
      open: false,
      priorityLabel: null,
    });
  });
});

describe('who may do what', () => {
  const mine = person(1);
  const assigned = job(1, { status: 'assigned', assignments: [row(1, { person: mine })] });

  test('own job is the session party on an assignment; a device session has none', () => {
    expect(isOwnJob(assigned, mine.partyId)).toBe(true);
    expect(isOwnJob(assigned, id(999))).toBe(false);
    expect(isOwnJob(assigned, null)).toBe(false);
  });

  test('a manager gets the machine’s moves, Cancel as its own button', () => {
    const manager = { role: 'manager' as const, partyId: null, canPlan: true };
    expect(statusActions(job(1, { status: 'requested' }), manager)).toEqual({
      statuses: ['planned'],
      canCancel: true,
    });
    expect(statusActions(assigned, manager)).toEqual({
      statuses: ['in_progress'],
      canCancel: true,
    });
    expect(statusActions(job(1, { status: 'in_progress' }), manager)).toEqual({
      statuses: ['done'],
      canCancel: true,
    });
    // done -> in_progress (a mistake), never cancel; invoiced is billing's.
    expect(statusActions(job(1, { status: 'done' }), manager)).toEqual({
      statuses: ['in_progress'],
      canCancel: false,
    });
    // planned -> assigned is never a button.
    expect(statusActions(job(1, { status: 'planned' }), manager)).toEqual({
      statuses: [],
      canCancel: true,
    });
    expect(canPlan(manager)).toBe(true);
  });

  test('a driver on their own job only; a viewer nothing', () => {
    const driver = { role: 'driver' as const, partyId: mine.partyId, canPlan: false };
    expect(statusActions(assigned, driver)).toEqual({
      statuses: ['in_progress'],
      canCancel: false,
    });
    expect(statusActions({ ...assigned, assignments: [] }, driver)).toEqual({
      statuses: [],
      canCancel: false,
    });
    const viewer = { role: 'viewer' as const, partyId: null, canPlan: false };
    expect(statusActions(assigned, viewer)).toEqual({ statuses: [], canCancel: false });
    expect(canPlan(driver)).toBe(false);
    // The hint from the server never outranks the role.
    expect(canPlan({ role: 'driver', partyId: null, canPlan: true })).toBe(false);
  });

  test('button words', () => {
    expect(statusActionLabel('requested', 'planned')).toBe('Accept request');
    expect(statusActionLabel('assigned', 'in_progress')).toBe('Start');
    expect(statusActionLabel('in_progress', 'done')).toBe('Mark done');
    expect(statusActionLabel('done', 'in_progress')).toMatch(/back to in progress/);
  });
});

describe('lanes and the snapshot', () => {
  test('open by priority, sort key, created; then the day’s done jobs', () => {
    const a = job(1, { priority: 3, sortKey: 20 });
    const b = job(2, { priority: 3, sortKey: 10 });
    const c = job(3, { priority: 1, sortKey: 90 });
    const d = job(4, { status: 'done', statusChangedAt: '2026-11-06T15:00:00Z' });
    const e = job(5, { status: 'done', statusChangedAt: '2026-11-06T14:00:00Z' });
    expect(sortLaneJobs([a, d, b, e, c]).map((j) => j.id)).toEqual([c.id, b.id, a.id, e.id, d.id]);
  });

  test('a job a write answered: in place, moved lanes to the end of its priority, or gone', () => {
    const a = job(1, { sortKey: 10 });
    const b = job(2, { sortKey: 20 });
    const g = job(3, { businessLine: 'grain', sortKey: 10 });
    const s = snapshot([a, b, g]);
    const inPlace = mergeJob(s, { ...a, version: 2, title: 'Renamed' });
    expect(findJob(inPlace, a.id)?.title).toBe('Renamed');
    expect(inPlace.lanes[0]?.jobs.map((j) => j.id)).toEqual([a.id, b.id]);

    const moved = mergeJob(s, { ...a, version: 2, businessLine: 'grain' });
    expect(moved.lanes[0]?.jobs.map((j) => j.id)).toEqual([b.id]);
    expect(moved.lanes[1]?.jobs.map((j) => j.id)).toEqual([g.id, a.id]);

    expect(findJob(mergeJob(s, { ...a, version: 2, status: 'cancelled' }), a.id)).toBeNull();
    expect(findJob(mergeJob(s, { ...a, version: 2, status: 'done' }), a.id)?.status).toBe('done');
    // A brand-new job (the form saved it) lands in its lane.
    const n = job(9, { businessLine: 'store' });
    expect(mergeJob(s, n).lanes[3]?.jobs.map((j) => j.id)).toEqual([n.id]);
  });

  test('an older fetch never takes a newer answer back', () => {
    const a = job(1);
    const local = snapshot([{ ...a, version: 3, title: 'mine' }]);
    const fetched = snapshot([{ ...a, version: 2 }]);
    const merged = reconcileSnapshot(fetched, local, new Map([[a.id, 3]]));
    expect(findJob(merged, a.id)).toMatchObject({ version: 3, title: 'mine' });
    // Caught up: the fetch wins.
    const later = snapshot([{ ...a, version: 4, title: 'theirs' }]);
    expect(findJob(reconcileSnapshot(later, local, new Map([[a.id, 3]])), a.id)?.title).toBe(
      'theirs',
    );
    // Always four lanes, even if a snapshot left one out.
    expect(reconcileSnapshot({ ...fetched, lanes: [] }, null, new Map()).lanes).toHaveLength(4);
  });

  test('counts', () => {
    const s = snapshot([
      job(1, { status: 'requested' }),
      job(2, { businessLine: 'grain' }),
      job(3, { status: 'done' }),
    ]);
    expect(boardCounts(s)).toMatchObject({ open: 2, requested: 1 });
    expect(boardCounts(s).lanes.map((l) => l.open)).toEqual([1, 1, 0, 0]);
    expect(boardCounts(null).open).toBe(0);
  });
});

describe('move up / move down', () => {
  const a = job(1, { priority: 2, sortKey: 10 });
  const b = job(2, { priority: 3, sortKey: 10, version: 4 });
  const c = job(3, { priority: 3, sortKey: 20, version: 7 });
  const d = job(4, { priority: 3, sortKey: 30 });
  const done = job(5, { status: 'done' });
  const lane = snapshot([a, b, c, d, done]).lanes[0] ?? null;

  test('only within the card’s priority', () => {
    expect(moveOptions(lane, b.id)).toMatchObject({ up: false, down: true });
    expect(moveOptions(lane, b.id).hint).toMatch(/priority/);
    expect(moveOptions(lane, c.id)).toEqual({ up: true, down: true, hint: null });
    expect(moveOptions(lane, d.id)).toMatchObject({ up: true, down: false });
    expect(moveOptions(lane, a.id)).toMatchObject({ up: false, down: false });
    expect(moveOptions(lane, done.id)).toEqual({ up: false, down: false, hint: null });
  });

  test('the body lists every open job of the lane in the new order, with versions', () => {
    expect(reorderedLane(lane, c.id, 'up')).toEqual([
      { id: a.id, version: 1 },
      { id: c.id, version: 7 },
      { id: b.id, version: 4 },
      { id: d.id, version: 1 },
    ]);
    expect(reorderedLane(lane, b.id, 'up')).toBeNull();
    expect(reorderedLane(lane, d.id, 'down')).toBeNull();
  });
});

describe('chips', () => {
  const m = (p: Partial<PanelMachine>): PanelMachine =>
    ({
      id: id(1),
      unitNo: 'X',
      kind: 'sprayer',
      make: null,
      model: null,
      status: 'active',
      downReason: null,
      downAt: null,
      downBy: null,
      position: null,
      place: null,
      ...p,
    }) as PanelMachine;

  test('machines: not retired, natural order, the Deere badge from the machine', () => {
    const chips = machineChips([
      m({ id: id(1), unitNo: 'SP10' }),
      m({ id: id(2), unitNo: 'SP2', workPlanCapable: false }),
      m({ id: id(3), unitNo: 'SP1', workPlanCapable: true }),
      m({ id: id(4), unitNo: 'C9', status: 'retired' }),
      m({ id: id(5), unitNo: 'C1', status: 'down' }),
    ]);
    expect(chips.map((c) => c.unitNo)).toEqual(['C1', 'SP1', 'SP2', 'SP10']);
    expect(chips.find((c) => c.unitNo === 'SP1')?.workPlanCapable).toBe(true);
    expect(chips.find((c) => c.unitNo === 'SP2')?.workPlanCapable).toBe(false);
    expect(chips.find((c) => c.unitNo === 'C1')?.status).toBe('down');
  });

  test('people', () => {
    const crew: CrewPerson[] = [
      {
        partyId: id(1),
        appUserId: null,
        name: 'Dale Mercer',
        initials: '',
        appRole: null,
        active: true,
      },
      {
        partyId: id(2),
        appUserId: id(3),
        name: 'Amy',
        initials: 'AK',
        appRole: 'manager',
        active: false,
      },
    ];
    expect(personChips(crew)).toEqual([
      { partyId: id(1), name: 'Dale Mercer', initials: 'DM', inactive: false },
      { partyId: id(2), name: 'Amy', initials: 'AK', inactive: true },
    ]);
    expect(initialsOf('Luis  Ortega')).toBe('LO');
    expect(initialsOf('Cher')).toBe('CH');
    expect(initialsOf('')).toBe('');
  });
});
