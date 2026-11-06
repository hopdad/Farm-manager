/**
 * The board's pieces rendered to HTML (react-dom/server, no browser): the card's test ids and
 * data attributes (contracts-2a §7.5), what a planner sees and a viewer doesn't (no grip, no ×,
 * not draggable), the "Deere" badge rule, and the job detail's buttons per role. The drags, the
 * sheet and realtime are covered by e2e/m2a-board*.spec.ts.
 */
import { DndContext } from '@dnd-kit/core';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { JobView } from '../contract';
import { createBoardApi } from './api';
import { createBoardStore } from './board-store';
import { BoardStoreContext } from './context';
import { INITIAL_FEED_STATE } from './feed';
import { JobCard } from './JobCard';
import { JobDetail } from './JobDetail';
import { type BoardViewer, normalizeLanes, sortLaneJobs } from './model';
import { makeJobView } from './testkit';
import { WorkBoard } from './WorkBoard';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DALE = { partyId: id(20), name: 'Dale Mercer', initials: 'DM' };
const SP2 = {
  id: id(10),
  unitNo: 'SP2',
  kind: 'sprayer' as const,
  status: 'active' as const,
  workPlanCapable: true,
};

const JOB = makeJobView({
  id: id(1),
  kind: 'spray',
  status: 'assigned',
  field: { id: id(2), name: 'Corwin 80', farmName: 'Halvorsen', boundaryAcres: 80 },
  plannedAcres: 78,
  flags: ['double_booked'],
  assignments: [
    {
      id: id(3),
      role: 'operator',
      machine: SP2,
      person: DALE,
      plannedFor: null,
      alsoOn: [{ jobId: id(9), summary: 'Spray · Other' }],
    },
  ],
});

function withStore(el: ReactElement, jobs: JobView[] = [JOB], viewer?: BoardViewer): string {
  // useStore renders the store's INITIAL state on the server (react-dom/server): seed it.
  const store = createBoardStore({
    api: createBoardApi((async () => new Response('{}')) as typeof fetch),
    initialFeed: {
      ...INITIAL_FEED_STATE,
      status: 'ready',
      snapshot: {
        asOf: '2026-11-06T17:00:00.000Z',
        viewer: viewer ?? { role: 'manager', partyId: null, canPlan: true },
        lanes: normalizeLanes([]).map((l) => ({
          ...l,
          jobs: sortLaneJobs(jobs.filter((j) => j.businessLine === l.businessLine)),
        })),
      },
    },
  });
  return renderToStaticMarkup(
    createElement(
      BoardStoreContext.Provider,
      { value: store },
      createElement(DndContext, null, el),
    ),
  );
}

const card = (job: JobView, planner: boolean, variant: 'wall' | 'phone' = 'wall') =>
  withStore(
    createElement(JobCard, {
      job,
      variant,
      planner,
      saving: false,
      selected: false,
      onOpen: () => {},
      onUnassign: () => {},
    }),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('the job card', () => {
  test('test ids and data attributes; the chip "SP2 · Dale Mercer"; flags', () => {
    const html = card(JOB, true);
    expect(html).toContain('data-testid="job-card"');
    expect(html).toContain(`data-job-id="${id(1)}"`);
    expect(html).toContain('data-status="assigned"');
    expect(html).toContain('data-business-line="spraying"');
    expect(html).toContain(`data-field-id="${id(2)}"`);
    expect(html).toContain('data-version="1"');
    expect(html).toContain('data-testid="job-assignment-chip"');
    expect(html).toContain(
      `data-assignment-id="${id(3)}" data-machine-id="${id(10)}" data-party-id="${id(20)}"`,
    );
    expect(html).toContain('SP2 · Dale Mercer');
    expect(html).toContain('data-testid="job-flag" data-flag="double_booked"');
    expect(html).toContain('78 ac (boundary 80 ac)');
    // A spray job can become a Work Plan: the machine's Deere badge shows.
    expect(count(html, '>Deere<')).toBe(1);
    expect(card({ ...JOB, field: null }, true)).toContain('data-field-id=""');
  });

  test('a planner gets the grip, the × and a draggable card; a viewer none of them', () => {
    const planner = card(JOB, true);
    expect(planner).toContain('data-draggable="true"');
    expect(planner).toContain('data-testid="job-drag-handle"');
    expect(planner).toContain('data-testid="job-assignment-remove"');
    const viewer = card(JOB, false);
    expect(viewer).toContain('data-draggable="false"');
    expect(viewer).not.toContain('job-drag-handle');
    expect(viewer).not.toContain('job-assignment-remove');
    expect(viewer).not.toContain('aria-roledescription');
  });

  test('a done card is not draggable; no Deere badge on a haul', () => {
    expect(card({ ...JOB, status: 'done' }, true)).toContain('data-draggable="false"');
    expect(card({ ...JOB, kind: 'haul' }, true)).not.toContain('>Deere<');
  });
});

const detail = (job: JobView, viewer: BoardViewer) =>
  withStore(
    createElement(JobDetail, {
      job,
      variant: 'wall',
      viewer,
      mode: 'view',
      onMode: () => {},
      onGone: () => {},
    }),
    [job],
    viewer,
  );

describe('the job detail’s buttons (decision 2a-2)', () => {
  const manager = { role: 'manager' as const, partyId: null, canPlan: true };

  test('a manager: the moves, Cancel, Move up/down, Edit; also-on', () => {
    const html = detail(JOB, manager);
    expect(html).toContain('data-testid="job-detail"');
    expect(html).toContain('data-testid="job-status-in_progress"');
    expect(html).not.toContain('job-status-cancelled');
    expect(html).toContain('data-testid="job-cancel"');
    expect(html).toContain('data-testid="job-move-up"');
    expect(html).toContain('data-testid="job-move-down"');
    expect(html).toContain('data-testid="job-edit"');
    expect(html).toContain('Also on Spray · Other');
    // Alone in its lane: both moves are off, with the hint.
    expect(html).toContain('data-testid="job-move-hint"');
    expect(html).toMatch(/data-testid="job-move-up" disabled=""/);
  });

  test('a driver on their own job: Start only; on another’s nothing', () => {
    const own = detail(JOB, { role: 'driver', partyId: DALE.partyId, canPlan: false });
    expect(own).toContain('data-testid="job-status-in_progress"');
    expect(own).not.toContain('job-cancel');
    expect(own).not.toContain('job-move-up');
    expect(own).not.toContain('job-edit');
    const other = detail(JOB, { role: 'driver', partyId: id(99), canPlan: false });
    expect(other).not.toContain('job-status-');
  });

  test('a viewer: no buttons at all', () => {
    const html = detail(JOB, { role: 'viewer', partyId: null, canPlan: false });
    expect(html).not.toContain('job-status-');
    expect(html).not.toContain('job-cancel');
    expect(html).not.toContain('job-move');
    expect(html).not.toContain('job-edit');
  });
});

describe('the board shells', () => {
  const config = { appEnv: 'test', realtime: 'sse' } as never;

  test('the wall band: its ids, four lanes, New job for a planner', () => {
    const html = withStore(createElement(WorkBoard, { variant: 'wall', map: null, config }));
    expect(html).toContain('data-testid="jobs-band" data-variant="wall" data-collapsed="false"');
    expect(count(html, 'data-testid="jobs-lane"')).toBe(4);
    expect(html).toContain('data-business-line="spraying"');
    expect(html).toContain('data-testid="jobs-band-toggle"');
    expect(html).toContain('data-testid="job-new"');
    expect(html).toContain('data-testid="jobs-chips-tray"');
    const viewer = withStore(
      createElement(WorkBoard, { variant: 'wall', map: null, config }),
      [JOB],
      {
        role: 'viewer',
        partyId: null,
        canPlan: false,
      },
    );
    expect(viewer).not.toContain('job-new');
  });

  test('the phone: the pill only (the sheet is closed by default)', () => {
    const html = withStore(createElement(WorkBoard, { variant: 'phone', map: null, config }));
    expect(html).toContain('data-testid="jobs-pill"');
    expect(html).not.toContain('jobs-sheet');
    expect(html).not.toContain('jobs-band');
  });
});
