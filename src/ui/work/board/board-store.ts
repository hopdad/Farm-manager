/**
 * The job board's data and writes for one page (framework-free zustand store; created by
 * WorkBoardProvider, fed by WorkBoard's feed, read by the band, the sheet, the cards and the
 * drop handler; ./board-store.test.ts drives it with a fake API):
 *
 *  - the snapshot as fetched (./feed.ts), merged with what this screen's own writes answered
 *    (a write's job is shown at once; an older fetch in flight never takes it back);
 *  - the writes of a drop (field, machine, person), the × on an assignment chip, the status
 *    buttons, Cancel and Move up / Move down, each with the version the screen holds; writes to
 *    one job run one after another (a second drop waits for the first answer and sends its
 *    version), so quick drags never conflict with themselves;
 *  - a 409 replaces the job with the CURRENT one from the answer and says JOB_CONFLICT_MESSAGE
 *    (decision 2a-7); any other refusal says why; nothing is retried behind the user's back.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { JobStatus } from '../../../domain/work-jobs';
import type { AssignmentPart, BoardSnapshot, JobView } from '../contract';
import type { BoardApi, ReorderResult, WriteFailure, WriteResult } from './api';
import type { BoardFeed, FeedState } from './feed';
import { INITIAL_FEED_STATE } from './feed';
import {
  type BoardViewer,
  findJob,
  laneOf,
  mergeJob,
  reconcileSnapshot,
  reorderedLane,
  SIGNED_OUT_VIEWER,
} from './model';

/** Where a dragged card was dropped (resolved by WorkBoardProvider, decision 2a-4). */
export type DropTarget =
  | { kind: 'field'; fieldId: string }
  | { kind: 'point'; lngLat: { lng: number; lat: number } }
  | { kind: 'machine'; machineId: string }
  | { kind: 'person'; partyId: string };

export type NoticeTone = 'conflict' | 'error' | 'info';

export interface Notice {
  /** Changes with every notice (the UI restarts its timer). */
  id: number;
  tone: NoticeTone;
  text: string;
  jobId: string | null;
}

export interface BoardState {
  /** The HTTP client (the feed reads with it, the writes below write with it). */
  api: BoardApi;
  feed: FeedState;
  /** The board as this screen shows it (the fetch, plus its own writes' answers). */
  snapshot: BoardSnapshot | null;
  viewer: BoardViewer;
  /** Writes in flight per job (the card shows "saving", the detail's buttons wait). */
  pending: Readonly<Record<string, number>>;
  /** The card being dragged. */
  dragging: { jobId: string } | null;
  notice: Notice | null;

  attachFeed(feed: BoardFeed | null): void;
  setFeed(state: FeedState): void;
  refetch(): void;
  applyJob(job: JobView): void;
  applySnapshot(snapshot: BoardSnapshot): void;
  dragStart(jobId: string): void;
  dragEnd(): void;
  drop(jobId: string, target: DropTarget): Promise<WriteResult | null>;
  unassign(jobId: string, assignmentId: string, part?: AssignmentPart): Promise<WriteResult | null>;
  setStatus(jobId: string, status: JobStatus): Promise<WriteResult | null>;
  cancel(jobId: string, reason: string | null): Promise<WriteResult | null>;
  move(jobId: string, direction: 'up' | 'down'): Promise<ReorderResult | null>;
  /** The job form saved a job (POST or PATCH answered it). */
  jobSaved(job: JobView): void;
  say(tone: NoticeTone, text: string, jobId?: string | null): void;
  dismiss(id?: number): void;
}

export type BoardStore = StoreApi<BoardState>;

export interface BoardStoreOptions {
  api: BoardApi;
  /** What the store starts with (tests render a board with data; the app starts empty). */
  initialFeed?: FeedState;
}

const viewerOf = (s: BoardSnapshot | null): BoardViewer =>
  s
    ? { role: s.viewer.role, partyId: s.viewer.partyId, canPlan: s.viewer.canPlan }
    : SIGNED_OUT_VIEWER;

export function createBoardStore(opts: BoardStoreOptions): BoardStore {
  const { api } = opts;
  let feed: BoardFeed | null = null;
  let noticeSeq = 0;
  /** Versions this screen's writes have seen per job (an older fetch never takes them back). */
  const minVersions = new Map<string, number>();
  /** One write at a time per job. */
  const queues = new Map<string, Promise<unknown>>();

  const store = createStore<BoardState>()((set, get) => {
    const bump = (jobId: string, by: 1 | -1) =>
      set((s) => {
        const n = (s.pending[jobId] ?? 0) + by;
        const pending = { ...s.pending };
        if (n > 0) pending[jobId] = n;
        else delete pending[jobId];
        return { pending };
      });

    const remember = (job: JobView) => {
      minVersions.set(job.id, Math.max(minVersions.get(job.id) ?? 0, job.version));
    };

    const failed = (f: WriteFailure, jobId: string) => {
      if (f.kind === 'conflict') {
        get().applyJob(f.job);
        get().say('conflict', f.message, jobId);
      } else {
        get().say('error', f.message, jobId);
      }
    };

    /**
     * Run `write` for `jobId` after the job's earlier writes, with the job as it is then, and
     * `settle` its answer before the next write of that job starts (so it sends the new version).
     * The job counts as saving from the moment the write is queued.
     */
    function serial<R extends WriteResult | ReorderResult>(
      jobId: string,
      write: (job: JobView) => Promise<R> | null,
      settle: (r: R) => void,
    ): Promise<R | null> {
      const prev = queues.get(jobId) ?? Promise.resolve();
      bump(jobId, 1);
      const run = prev
        .catch(() => {})
        .then(async () => {
          const job = findJob(get().snapshot, jobId);
          const p = job ? write(job) : null;
          if (!p) return null;
          const r = await p;
          settle(r);
          return r;
        })
        .finally(() => bump(jobId, -1));
      queues.set(jobId, run);
      void run
        .catch(() => {})
        .then(() => {
          if (queues.get(jobId) === run) queues.delete(jobId);
        });
      return run;
    }

    function jobWrite(
      jobId: string,
      write: (job: JobView) => Promise<WriteResult> | null,
    ): Promise<WriteResult | null> {
      return serial(jobId, write, (r) => {
        if (r.ok) get().applyJob(r.job);
        else failed(r, jobId);
      });
    }

    return {
      api,
      feed: opts.initialFeed ?? INITIAL_FEED_STATE,
      snapshot: opts.initialFeed?.snapshot ?? null,
      viewer: viewerOf(opts.initialFeed?.snapshot ?? null),
      pending: {},
      dragging: null,
      notice: null,

      attachFeed(f) {
        feed = f;
      },
      setFeed(state) {
        const local = get().snapshot;
        const snapshot = state.snapshot
          ? reconcileSnapshot(state.snapshot, local, minVersions)
          : null;
        if (state.snapshot) {
          // Forget what the server has caught up with.
          for (const [id, min] of minVersions) {
            const there = findJob(state.snapshot, id);
            if (!there || there.version >= min) minVersions.delete(id);
          }
        } else {
          minVersions.clear();
        }
        set({ feed: state, snapshot, viewer: viewerOf(snapshot) });
      },
      refetch() {
        feed?.refetch();
      },
      applyJob(job) {
        remember(job);
        const s = get().snapshot;
        if (!s) return;
        const there = findJob(s, job.id);
        if (there && there.version > job.version) return;
        set({ snapshot: mergeJob(s, job) });
      },
      applySnapshot(snapshot) {
        const merged = reconcileSnapshot(snapshot, get().snapshot, minVersions);
        for (const lane of snapshot.lanes) for (const j of lane.jobs) remember(j);
        set({ snapshot: merged, viewer: viewerOf(merged) });
      },
      dragStart(jobId) {
        set({ dragging: { jobId } });
      },
      dragEnd() {
        if (get().dragging) set({ dragging: null });
      },
      drop(jobId, target) {
        return jobWrite(jobId, (job) => {
          switch (target.kind) {
            case 'field':
              // Already on that field: nothing to change.
              if (job.field?.id === target.fieldId) return null;
              return api.setField(job, { fieldId: target.fieldId });
            case 'point':
              return api.setField(job, { at: target.lngLat });
            case 'machine':
              return api.assign(job, { machineId: target.machineId });
            case 'person':
              return api.assign(job, { partyId: target.partyId });
          }
        });
      },
      unassign(jobId, assignmentId, part) {
        return jobWrite(jobId, (job) =>
          job.assignments.some((a) => a.id === assignmentId)
            ? api.unassign(job, assignmentId, part)
            : null,
        );
      },
      setStatus(jobId, status) {
        return jobWrite(jobId, (job) =>
          job.status === status ? null : api.setStatus(job, status),
        );
      },
      cancel(jobId, reason) {
        return jobWrite(jobId, (job) => api.cancel(job, reason));
      },
      move(jobId, direction) {
        return serial<ReorderResult>(
          jobId,
          (job) => {
            const lane = laneOf(get().snapshot, job.businessLine);
            const order = reorderedLane(lane, jobId, direction);
            return order ? api.reorder(job.businessLine, order) : null;
          },
          (r) => {
            if (r.ok) get().applySnapshot(r.snapshot);
            else failed(r, jobId);
          },
        );
      },
      jobSaved(job) {
        get().applyJob(job);
        feed?.refetch();
      },
      say(tone, text, jobId = null) {
        noticeSeq += 1;
        set({ notice: { id: noticeSeq, tone, text, jobId } });
      },
      dismiss(id) {
        const n = get().notice;
        if (n && (id === undefined || n.id === id)) set({ notice: null });
      },
    };
  });
  return store;
}
