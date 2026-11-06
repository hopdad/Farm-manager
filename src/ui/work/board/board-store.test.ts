/**
 * The board store's writes against the API stand-in (./testkit.ts) through the real HTTP client
 * (./api.ts): a drop's answer shows at once, a 409 replaces the job and says the conflict
 * message, writes to one job run one after another with fresh versions, an older fetch never
 * takes a newer answer back.
 */
import { describe, expect, test } from 'vitest';
import { JOB_CONFLICT_MESSAGE, type JobView } from '../contract';
import { createBoardApi } from './api';
import { createBoardStore } from './board-store';
import { INITIAL_FEED_STATE } from './feed';
import { findJob } from './model';
import { createMapWorld, MockJobsApi, type MockViewer, makeJobView, mockFetch } from './testkit';

const NOW = new Date('2026-11-06T17:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIELD = { id: id(1), name: 'Corwin 80', farmName: 'Halvorsen', boundaryAcres: 78 };
const SP2 = {
  id: id(10),
  unitNo: 'SP2',
  kind: 'sprayer' as const,
  status: 'active' as const,
  workPlanCapable: false,
};
const DALE = {
  partyId: id(20),
  appUserId: null,
  name: 'Dale Mercer',
  initials: 'DM',
  appRole: 'operator' as const,
  active: true,
};

function setup(
  viewer: MockViewer = { role: 'manager', partyId: null },
  jobs: Partial<JobView>[] = [{}],
) {
  const mock = new MockJobsApi(
    createMapWorld({ fields: [{ ...FIELD, customer: null }], machines: [SP2], crew: [DALE] }),
    { now: () => NOW },
  );
  jobs.forEach((p, i) => {
    mock.put(makeJobView({ id: id(100 + i), kind: 'spray', status: 'requested', ...p }, NOW));
  });
  const store = createBoardStore({ api: createBoardApi(mockFetch(mock, viewer)) });
  const load = () =>
    store
      .getState()
      .setFeed({ ...INITIAL_FEED_STATE, status: 'ready', snapshot: mock.snapshot(viewer) });
  load();
  const job = (n = 0) => findJob(store.getState().snapshot, id(100 + n)) as JobView;
  return { mock, store, job, load };
}

describe('drops', () => {
  test('field, machine, person: each answer shows at once', async () => {
    const { store, job } = setup();
    expect(store.getState().viewer).toEqual({ role: 'manager', partyId: null, canPlan: true });
    await store.getState().drop(id(100), { kind: 'field', fieldId: FIELD.id });
    expect(job()).toMatchObject({ version: 2, field: { id: FIELD.id } });
    await store.getState().drop(id(100), { kind: 'machine', machineId: SP2.id });
    await store.getState().drop(id(100), { kind: 'person', partyId: DALE.partyId });
    expect(job()).toMatchObject({ version: 4, status: 'assigned' });
    expect(job().assignments.map((a) => [a.machine?.unitNo, a.person?.name])).toEqual([
      ['SP2', 'Dale Mercer'],
    ]);
    expect(store.getState().notice).toBeNull();
    expect(store.getState().pending).toEqual({});
  });

  test('quick drops on one job wait for each other and send fresh versions', async () => {
    const { store, job, mock } = setup();
    const a = store.getState().drop(id(100), { kind: 'field', fieldId: FIELD.id });
    const b = store.getState().drop(id(100), { kind: 'machine', machineId: SP2.id });
    const c = store.getState().drop(id(100), { kind: 'person', partyId: DALE.partyId });
    expect(store.getState().pending[id(100)]).toBeGreaterThan(0);
    const results = await Promise.all([a, b, c]);
    expect(results.map((r) => r?.ok)).toEqual([true, true, true]);
    expect(job().version).toBe(4);
    expect(mock.calls('PUT', `/api/v1/jobs/${id(100)}/field`)[0]?.body).toMatchObject({
      version: 1,
    });
    expect(mock.calls('POST', `/api/v1/jobs/${id(100)}/assignments`).map((c) => c.body)).toEqual([
      { version: 2, machineId: SP2.id },
      { version: 3, partyId: DALE.partyId },
    ]);
  });

  test('the same field again sends nothing; a drop by point, not on a field, says so', async () => {
    const { store, mock } = setup(undefined, [{ field: { ...FIELD } }]);
    expect(await store.getState().drop(id(100), { kind: 'field', fieldId: FIELD.id })).toBeNull();
    expect(mock.calls('PUT', '/api/v1/jobs')).toEqual([]);
    const r = await store
      .getState()
      .drop(id(100), { kind: 'point', lngLat: { lng: -83, lat: 41 } });
    expect(r).toMatchObject({ ok: false, kind: 'rule', reason: 'not_on_field' });
    expect(store.getState().notice).toMatchObject({
      tone: 'error',
      text: 'That spot is not on a field',
    });
  });

  test('409: the current job replaces the screen’s copy and the board says so', async () => {
    const { store, job, mock } = setup();
    mock.touch(id(100), { title: 'Changed elsewhere' });
    const r = await store.getState().drop(id(100), { kind: 'machine', machineId: SP2.id });
    expect(r).toMatchObject({ ok: false, kind: 'conflict' });
    expect(job()).toMatchObject({ version: 2, title: 'Changed elsewhere', assignments: [] });
    expect(store.getState().notice).toMatchObject({
      tone: 'conflict',
      text: JOB_CONFLICT_MESSAGE,
      jobId: id(100),
    });
  });

  test('a viewer’s write is refused by the server whatever the screen shows', async () => {
    const { store, job } = setup({ role: 'viewer', partyId: null });
    expect(store.getState().viewer.canPlan).toBe(false);
    const r = await store.getState().drop(id(100), { kind: 'machine', machineId: SP2.id });
    expect(r).toMatchObject({ ok: false, kind: 'denied' });
    expect(job().assignments).toEqual([]);
    expect(store.getState().notice?.tone).toBe('error');
  });
});

describe('the detail’s writes', () => {
  test('status, unassign, cancel', async () => {
    const { store, job } = setup(undefined, [{ field: { ...FIELD }, status: 'planned' }]);
    await store.getState().drop(id(100), { kind: 'machine', machineId: SP2.id });
    expect(job().status).toBe('assigned');
    await store.getState().setStatus(id(100), 'in_progress');
    expect(job().status).toBe('in_progress');
    expect(await store.getState().setStatus(id(100), 'in_progress')).toBeNull();
    await store.getState().unassign(id(100), job().assignments[0]?.id as string);
    expect(job().assignments).toEqual([]);
    const r = await store.getState().cancel(id(100), 'rained out');
    expect(r?.ok).toBe(true);
    expect(findJob(store.getState().snapshot, id(100))).toBeNull();
  });

  test('move: reorder with the lane, the snapshot answered', async () => {
    const { store, mock } = setup(undefined, [{ sortKey: 10 }, { sortKey: 20 }, { sortKey: 30 }]);
    await store.getState().move(id(101), 'up');
    expect(mock.calls('POST', '/api/v1/jobs/reorder')[0]?.body).toEqual({
      businessLine: 'spraying',
      jobs: [
        { id: id(101), version: 1 },
        { id: id(100), version: 1 },
        { id: id(102), version: 1 },
      ],
    });
    expect(store.getState().snapshot?.lanes[0]?.jobs.map((j) => j.id)).toEqual([
      id(101),
      id(100),
      id(102),
    ]);
    // The edge of the priority: nothing sent.
    expect(await store.getState().move(id(101), 'up')).toBeNull();
  });
});

describe('fetches and local answers', () => {
  test('an older fetch never takes a newer answer back; a newer one wins', async () => {
    const { store, job, mock } = setup();
    const stale = mock.snapshot({ role: 'manager', partyId: null });
    await store.getState().drop(id(100), { kind: 'field', fieldId: FIELD.id });
    store.getState().setFeed({ ...INITIAL_FEED_STATE, status: 'ready', snapshot: stale });
    expect(job()).toMatchObject({ version: 2, field: { id: FIELD.id } });
    mock.touch(id(100), { title: 'Theirs' });
    store.getState().setFeed({
      ...INITIAL_FEED_STATE,
      status: 'ready',
      snapshot: mock.snapshot({ role: 'manager', partyId: null }),
    });
    expect(job()).toMatchObject({ version: 3, title: 'Theirs' });
  });

  test('notices: one at a time, dismissed by id', () => {
    const { store } = setup();
    store.getState().say('info', 'one');
    const first = store.getState().notice?.id as number;
    store.getState().say('error', 'two', id(100));
    store.getState().dismiss(first);
    expect(store.getState().notice?.text).toBe('two');
    store.getState().dismiss();
    expect(store.getState().notice).toBeNull();
  });

  test('drag state', () => {
    const { store } = setup();
    store.getState().dragStart(id(100));
    expect(store.getState().dragging).toEqual({ jobId: id(100) });
    store.getState().dragEnd();
    expect(store.getState().dragging).toBeNull();
  });
});
