'use client';
/**
 * The job board on /board and /m (slice 2a; docs/contracts-2a.md §7.1): the wall's jobs band
 * (lanes by business line, cards, "New job", the chips tray, the collapse bar) and the phone's
 * "Jobs" pill with its bottom sheet (chips tray pinned on top; it drops to peek when a drag
 * starts). Self-contained: it loads the snapshot (GET /api/v1/jobs), the crew (GET
 * /api/v1/crew) and the machines (`useFleetPanel()`'s shared feed, no second fetch), and follows
 * the `jobs` realtime topic (./feed.ts). Rendered inside WorkBoardProvider (the drag context and
 * the page's board store).
 *
 *  - Wall: a row of its own between the status strip and the map area, 208 px by default
 *    (`--jobs-band`: the map area keeps 800 of 1080 px, 74 %; the floor is 65 %), collapsible to
 *    a 72 px bar (remembered on this device). Lanes side by side, each scrolling sideways; the
 *    chips tray at the right end; a tapped card opens its detail in a popover under the band.
 *  - Phone: the "Jobs" pill (third in the top-left stack) opens the sheet (z 22, the field
 *    panel's snaps, closed by default); a tapped card shows its detail in the sheet.
 *  - One sheet at a time (§7.2): opening the sheet or the popover calls `onOpen` (BoardScreen
 *    closes the field panel and the soil sheet); BoardScreen's closeWorkBoardOverlays() closes
 *    them when a field, a machine or a pin opens.
 *
 * The props are frozen (additive changes only). Test ids: contracts-2a §7.5.
 */
import { useDndContext } from '@dnd-kit/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TransitionEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PublicConfig } from '../../../config';
import { isOpenJobStatus } from '../../../domain/work-jobs';
import {
  clampDrag,
  SHEET_OPEN_SNAP,
  type SheetSnap,
  SNAP_LABELS,
  settleSnap,
  snapHeights,
  stepSnap,
  toggleSnap,
} from '../../fields/sheet';
import { resolveRealtimeClient } from '../../map/fleet/realtime';
import type { MapVariant } from '../../map/types';
import type { BoardLane, JobView } from '../contract';
import { ChipsTray } from './ChipsTray';
import { useBoard, useBoardStoreApi } from './context';
import { type FeedState, startBoardFeed } from './feed';
import { JobCard } from './JobCard';
import { JobDetail, NewJob } from './JobDetail';
import { boardCounts, canPlan, findJob, normalizeLanes } from './model';
import { NoticeBar } from './NoticeBar';
import { useWorkBoardUi } from './store';
import css from './work-board.module.css';

export interface WorkBoardProps {
  variant: MapVariant;
  /** The board's map (drop on a field, the hover highlight); null until loaded. */
  map: MapLibreMap | null;
  /** The page's public config (realtime client, app env). */
  config: PublicConfig;
  /** The board opened its sheet (phone) or a job popover (wall): close the other panels. */
  onOpen?(): void;
}

/** The wall band's default height and the collapsed bar's (contracts-2a §7.1). */
export const JOBS_BAND_PX = 208;
export const JOBS_BAND_COLLAPSED_PX = 72;

export function WorkBoard({ variant, config, onOpen }: WorkBoardProps) {
  useBoardFeed(config);
  return variant === 'phone' ? <PhoneJobs onOpen={onOpen} /> : <WallBand onOpen={onOpen} />;
}

/** Start the page's feed (snapshot, crew, `jobs` realtime) into the board store. */
function useBoardFeed(config: Pick<PublicConfig, 'appEnv' | 'realtime'>): void {
  const store = useBoardStoreApi();
  const { appEnv, realtime } = config;
  useEffect(() => {
    const feed = startBoardFeed({
      api: store.getState().api,
      realtime: resolveRealtimeClient({ appEnv, realtime }),
      onState: (s: FeedState) => store.getState().setFeed(s),
    });
    store.getState().attachFeed(feed);
    return () => {
      feed.stop();
      store.getState().attachFeed(null);
    };
  }, [store, appEnv, realtime]);
}

// ---------------------------------------------------------------------------------------------
// The band's collapse, remembered per device (localStorage; a private window just forgets)
// ---------------------------------------------------------------------------------------------

const COLLAPSED_KEY = 'farm.jobsBand.collapsed';
const COLLAPSED_EVENT = 'farm:jobs-band-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeCollapsed(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  window.addEventListener(COLLAPSED_EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(COLLAPSED_EVENT, cb);
  };
}

function useCollapsed(): [boolean, (v: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const set = useCallback((v: boolean) => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      // Storage blocked: the band still toggles until the page reloads.
    }
    window.dispatchEvent(new Event(COLLAPSED_EVENT));
  }, []);
  return [collapsed, set];
}

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

function useLanes(): BoardLane[] {
  const snapshot = useBoard((s) => s.snapshot);
  return useMemo(() => normalizeLanes(snapshot?.lanes ?? []), [snapshot]);
}

/** What the board says while it has no snapshot (loading, refused, not on this server yet). */
function feedMessage(feed: FeedState): string | null {
  if (feed.snapshot) return null;
  switch (feed.status) {
    case 'loading':
      return 'Loading jobs…';
    case 'denied':
      return 'Sign in to see the jobs';
    case 'unavailable':
      return 'The job board is not on this server yet';
    case 'error':
      return `Couldn't load the jobs (${feed.error ?? 'no connection'}); trying again`;
    default:
      return null;
  }
}

function Lane(props: {
  lane: BoardLane;
  variant: MapVariant;
  planner: boolean;
  selectedId: string | null;
  onOpen(jobId: string, anchor: DOMRect | null): void;
}) {
  const store = useBoardStoreApi();
  const pending = useBoard((s) => s.pending);
  const { lane, variant } = props;
  const open = lane.jobs.filter((j) => isOpenJobStatus(j.status)).length;
  const unassign = useCallback(
    (jobId: string, assignmentId: string) => void store.getState().unassign(jobId, assignmentId),
    [store],
  );
  return (
    <section
      className={`${css.lane} ${variant === 'phone' ? css.lanePhone : css.laneWall}`}
      data-testid="jobs-lane"
      data-business-line={lane.businessLine}
      aria-label={`${lane.label}: ${open} open`}
    >
      <h3 className={css.laneHead}>
        {lane.label}
        <span className={css.laneCount}>{open}</span>
      </h3>
      <div className={css.laneCards}>
        {lane.jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            variant={variant}
            planner={props.planner}
            saving={(pending[job.id] ?? 0) > 0}
            selected={props.selectedId === job.id}
            onOpen={props.onOpen}
            onUnassign={unassign}
          />
        ))}
        {lane.jobs.length === 0 && <p className={css.laneEmpty}>No jobs</p>}
      </div>
    </section>
  );
}

/** Escape closes (unless a drag or a field already used it). */
function useEscape(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) ref.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}

/** The detail of the job the UI store names (the popover's or the sheet's), or nothing. */
function DetailView({
  variant,
  onClose,
}: {
  variant: MapVariant;
  /** Close the popover (wall) / go back to the lanes (phone). */
  onClose(): void;
}) {
  const detail = useWorkBoardUi((s) => s.detail);
  const openDetail = useWorkBoardUi((s) => s.openDetail);
  const viewer = useBoard((s) => s.viewer);
  const job = useBoard((s) =>
    detail?.kind === 'job' ? findJob(s.snapshot, detail.jobId) : null,
  ) as JobView | null;
  if (!detail) return null;
  if (detail.kind === 'new') {
    return (
      <NewJob
        variant={variant}
        onSaved={(saved) => openDetail({ kind: 'job', jobId: saved.id, mode: 'view' })}
        onCancel={onClose}
      />
    );
  }
  if (!job) {
    return (
      <p className={css.muted} data-testid="job-detail-gone">
        This job is no longer on the board.
      </p>
    );
  }
  return (
    <JobDetail
      job={job}
      variant={variant}
      viewer={viewer}
      mode={detail.mode}
      onMode={(mode) => openDetail({ kind: 'job', jobId: job.id, mode })}
      onGone={onClose}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Wall
// ---------------------------------------------------------------------------------------------

function WallBand({ onOpen }: { onOpen?(): void }) {
  const [collapsed, setCollapsed] = useCollapsed();
  const lanes = useLanes();
  const feed = useBoard((s) => s.feed);
  const snapshot = useBoard((s) => s.snapshot);
  const viewer = useBoard((s) => s.viewer);
  const planner = canPlan(viewer);
  const overlayOpen = useWorkBoardUi((s) => s.overlayOpen);
  const detail = useWorkBoardUi((s) => s.detail);
  const openDetail = useWorkBoardUi((s) => s.openDetail);
  const setOverlayOpen = useWorkBoardUi((s) => s.setOverlayOpen);
  const bandRef = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState(0);
  const counts = boardCounts(snapshot);
  const message = feedMessage(feed);
  const popover = overlayOpen && detail !== null;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const openJob = useCallback(
    (jobId: string, rect: DOMRect | null) => {
      const band = bandRef.current?.getBoundingClientRect();
      setAnchor(rect && band ? rect.left - band.left : 0);
      openDetail({ kind: 'job', jobId, mode: 'view' });
      onOpenRef.current?.();
    },
    [openDetail],
  );
  const close = useCallback(() => setOverlayOpen(false), [setOverlayOpen]);
  useEscape(popover, close);

  return (
    <section
      ref={bandRef}
      className={`${css.band} ${collapsed ? css.bandCollapsed : ''}`}
      style={
        {
          '--jobs-band': `${JOBS_BAND_PX}px`,
          '--jobs-band-collapsed': `${JOBS_BAND_COLLAPSED_PX}px`,
        } as CSSProperties
      }
      data-testid="jobs-band"
      data-variant="wall"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Job board"
    >
      <div className={css.tools}>
        <button
          type="button"
          className={css.toggle}
          data-testid="jobs-band-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show the job board' : 'Hide the job board'}
          onClick={() => {
            if (!collapsed) setOverlayOpen(false);
            setCollapsed(!collapsed);
          }}
        >
          <span className={css.toggleTitle}>Jobs</span>
          <span className={css.toggleCount}>
            {counts.open} {collapsed ? '▾' : '▴'}
          </span>
        </button>
        {planner && !collapsed && (
          <button
            type="button"
            className={css.newJob}
            data-testid="job-new"
            onClick={() => {
              setAnchor(0);
              openDetail({ kind: 'new' });
              onOpenRef.current?.();
            }}
          >
            + New job
          </button>
        )}
      </div>
      {collapsed ? (
        <div className={css.collapsedSummary} data-testid="jobs-band-summary">
          {message ??
            [
              `${counts.open} open`,
              counts.requested ? `${counts.requested} requested` : null,
              ...counts.lanes.map((l) => `${l.label} ${l.open}`),
            ]
              .filter(Boolean)
              .join(' · ')}
        </div>
      ) : (
        <>
          <div className={css.lanes}>
            {message && (
              <p
                className={css.feedMessage}
                data-testid="jobs-feed-message"
                data-status={feed.status}
              >
                {message}
              </p>
            )}
            {!message &&
              lanes.map((lane) => (
                <Lane
                  key={lane.businessLine}
                  lane={lane}
                  variant="wall"
                  planner={planner}
                  selectedId={popover && detail?.kind === 'job' ? detail.jobId : null}
                  onOpen={openJob}
                />
              ))}
          </div>
          <ChipsTray variant="wall" />
        </>
      )}
      {feed.snapshot && feed.error && (
        <span className={css.stale} data-testid="jobs-stale" title={feed.error}>
          Not up to date
        </span>
      )}
      <NoticeBar placement="band" />
      {popover && !collapsed && (
        <div
          className={css.popover}
          style={{ '--anchor': `${anchor}px` } as CSSProperties}
          role="dialog"
          aria-modal="false"
          aria-label={detail?.kind === 'new' ? 'New job' : 'Job'}
          data-testid="job-popover"
        >
          <button
            type="button"
            className={css.popoverClose}
            aria-label="Close"
            data-testid="job-detail-close"
            onClick={close}
          >
            ×
          </button>
          <DetailView variant="wall" onClose={close} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------------------------

function PhoneJobs({ onOpen }: { onOpen?(): void }) {
  const overlayOpen = useWorkBoardUi((s) => s.overlayOpen);
  const setOverlayOpen = useWorkBoardUi((s) => s.setOverlayOpen);
  const snapshot = useBoard((s) => s.snapshot);
  const counts = boardCounts(snapshot);
  return (
    <>
      <button
        type="button"
        className={css.pill}
        data-testid="jobs-pill"
        data-variant="phone"
        aria-expanded={overlayOpen}
        aria-label={`Jobs: ${counts.open} open`}
        onClick={() => {
          setOverlayOpen(true);
          onOpen?.();
        }}
      >
        Jobs
        {snapshot && <span className={css.pillCount}>{counts.open}</span>}
      </button>
      {overlayOpen && <JobsSheet onClose={() => setOverlayOpen(false)} onOpen={onOpen} />}
    </>
  );
}

function JobsSheet({ onClose, onOpen }: { onClose(): void; onOpen?(): void }) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [snap, setSnap] = useState<SheetSnap>(SHEET_OPEN_SNAP);
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  const [resizing, setResizing] = useState(false);
  const heights = useMemo(() => snapHeights(viewportH), [viewportH]);
  const dragging = useBoard((s) => s.dragging !== null);
  const feed = useBoard((s) => s.feed);
  const viewer = useBoard((s) => s.viewer);
  const planner = canPlan(viewer);
  const lanes = useLanes();
  const counts = boardCounts(feed.snapshot);
  const detail = useWorkBoardUi((s) => s.detail);
  const openDetail = useWorkBoardUi((s) => s.openDetail);
  const closeDetail = useWorkBoardUi((s) => s.closeDetail);
  const { measureDroppableContainers } = useDndContext();
  const message = feedMessage(feed);
  const resize = useRef<{
    id: number;
    startY: number;
    startH: number;
    lastY: number;
    lastT: number;
    v: number;
    h: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  // The snap to go back to after a card drag (the sheet drops to peek while it runs).
  const beforeDrag = useRef<SheetSnap | null>(null);

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A card drag starts: down to peek, so the map is reachable while the chips stay in view.
  useEffect(() => {
    if (dragging) {
      setSnap((s) => {
        beforeDrag.current ??= s;
        return 'peek';
      });
    } else if (beforeDrag.current) {
      const back = beforeDrag.current;
      beforeDrag.current = null;
      setSnap(back);
    }
  }, [dragging]);

  const setVisible = useCallback(
    (h: number) => rootRef.current?.style.setProperty('--sheet-visible', `${Math.round(h)}px`),
    [],
  );
  useLayoutEffect(() => {
    if (resizing) return;
    rootRef.current?.style.setProperty('--sheet-full', `${heights.full}px`);
    setVisible(heights[snap]);
  }, [resizing, heights, snap, setVisible]);

  // The chips moved with the sheet: measure the drop targets again once it has settled (it
  // jumps to peek without the transition while a card is dragged, so its chips are in their
  // place at once; it slides back afterwards).
  const onTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && e.propertyName === 'height') measureDroppableContainers([]);
  };
  useEffect(() => {
    if (!dragging || snap !== 'peek') return;
    const frame = requestAnimationFrame(() => measureDroppableContainers([]));
    return () => cancelAnimationFrame(frame);
  }, [dragging, snap, measureDroppableContainers]);

  useEscape(true, () => (detail ? closeDetail() : onClose()));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('a, input, textarea, select, button:not([data-sheet-handle])')) return;
    resize.current = {
      id: e.pointerId,
      startY: e.clientY,
      startH: heights[snap],
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
      h: heights[snap],
      moved: false,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = resize.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;
      d.moved = true;
      setResizing(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.v = 0.7 * ((e.clientY - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    d.h = clampDrag(heights, d.startH - dy);
    setVisible(d.h);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = resize.current;
    if (!d || e.pointerId !== d.id) return;
    resize.current = null;
    if (!d.moved) return;
    suppressClick.current = true;
    const to = e.type === 'pointercancel' ? snap : settleSnap(heights, d.h, d.v);
    setResizing(false);
    if (to === 'close') {
      onClose();
      return;
    }
    setSnap(to);
  };
  const onHandleKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSnap((s) => stepSnap(s, e.key === 'ArrowUp' ? 1 : -1));
    }
  };
  const openJob = useCallback(
    (jobId: string) => openDetail({ kind: 'job', jobId, mode: 'view' }),
    [openDetail],
  );

  return (
    <section
      ref={rootRef}
      className={`${css.sheet} ${resizing || dragging ? css.sheetResizing : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="Jobs"
      data-testid="jobs-sheet"
      data-snap={snap}
      data-dock="bottom"
      onTransitionEnd={onTransitionEnd}
    >
      <div
        className={css.sheetGrab}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <h2 className={css.sheetTitle}>
          Jobs <span className={css.laneCount}>{counts.open}</span>
        </h2>
        <button
          type="button"
          className={css.sheetHandle}
          data-sheet-handle
          data-testid="jobs-sheet-handle"
          aria-label={`Resize the jobs sheet (now ${SNAP_LABELS[snap]}); arrow keys work too`}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setSnap(toggleSnap);
          }}
          onKeyDown={onHandleKey}
        >
          <span className={css.grip2} />
        </button>
        <div className={css.sheetActions}>
          {planner && (
            <button
              type="button"
              className={css.sheetButton}
              data-testid="job-new"
              onClick={() => {
                openDetail({ kind: 'new' });
                setSnap('full');
                onOpen?.();
              }}
            >
              + New
            </button>
          )}
          <button
            type="button"
            className={css.sheetButton}
            data-testid="jobs-sheet-close"
            aria-label="Close the jobs sheet"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <ChipsTray variant="phone" />
      <NoticeBar placement="sheet" />
      <div className={css.sheetBody}>
        {detail ? (
          <>
            <button
              type="button"
              className={css.back}
              data-testid="jobs-sheet-back"
              onClick={closeDetail}
            >
              ← All jobs
            </button>
            <DetailView variant="phone" onClose={closeDetail} />
          </>
        ) : message ? (
          <p className={css.feedMessage} data-testid="jobs-feed-message" data-status={feed.status}>
            {message}
          </p>
        ) : (
          lanes.map((lane) => (
            <Lane
              key={lane.businessLine}
              lane={lane}
              variant="phone"
              planner={planner}
              selectedId={null}
              onOpen={openJob}
            />
          ))
        )}
        {feed.snapshot && feed.error && (
          <p className={css.stale} data-testid="jobs-stale">
            Not up to date ({feed.error})
          </p>
        )}
      </div>
    </section>
  );
}
