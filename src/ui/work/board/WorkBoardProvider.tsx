'use client';
/**
 * The drag context of the job board (slice 2a; docs/contracts-2a.md §4.5, §7.1, §7.2).
 * BoardScreen wraps the wall's jobs band AND the map area in it, so the cards and the drop
 * targets (the chips tray, the map) share one dnd-kit `DndContext`. It also owns the page's
 * board store (./board-store.ts): WorkBoard feeds it, the cards and the drop handler read it.
 *
 *  - Sensors: MouseSensor (6 px), TouchSensor (200 ms hold, 8 px tolerance), KeyboardSensor
 *    (Space picks a card up by its grip, arrows move it, Space or Enter drops, Escape puts it
 *    back). Collision `chipsFirst` (./drop.ts): pointerWithin, chips before the map.
 *  - `autoScroll={false}`: the default scrolled a lane while the finger crossed its edge on the
 *    way to the chips tray. Droppables are measured continuously (MeasuringStrategy.Always,
 *    every 100 ms of movement): the phone sheet drops to peek when a drag starts and moves the
 *    tray's chips away from where they were measured.
 *  - While a drag runs the map's drag-pan and touch zoom/rotate are off (put back at the end or
 *    on cancel), and the field under the pointer is highlighted (./hover.ts).
 *  - A drop on a chip assigns the machine or person; on the map, the field under the drop point
 *    (`queryRenderedFeatures` on `fields-fill`, or the point's lng/lat when the fields layer is
 *    hidden or below the field tiles' zoom); anywhere else nothing changes and the card springs
 *    back. A drop never opens the field panel. A finger's or the mouse's drop goes by what is
 *    really under it when it is let go (`targetAt`: the measured rectangles can lag behind the
 *    phone sheet still sliding to peek); a keyboard drop by dnd-kit's collision (`over`).
 *  - The DragOverlay is above everything (DRAG_OVERLAY_Z_INDEX) and lets the pointer through.
 *
 * The props are frozen (additive changes only).
 */
import {
  type Announcements,
  DndContext,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  defaultDropAnimation,
  KeyboardCode,
  KeyboardSensor,
  type MeasuringConfiguration,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MapVariant } from '../../map/types';
import { DRAG_OVERLAY_Z_INDEX } from '../style';
import { createBoardApi } from './api';
import { createBoardStore, type DropTarget } from './board-store';
import { BoardStoreContext, useBoard } from './context';
import {
  chipsFirst,
  type DragData,
  type DropData,
  fieldAt,
  MAP_DROP_ID,
  mapPointAt,
  type PointTarget,
  resolveMapDrop,
  suspendMapGestures,
  targetAt,
} from './drop';
import { removeDropHover, showDropHover } from './hover';
import { OverlayCard } from './JobCard';
import { findJob } from './model';
import { closeWorkBoardOverlays, useWorkBoardUi } from './store';
import css from './work-board.module.css';

export interface WorkBoardProviderProps {
  variant: MapVariant;
  /** The board's map (WarRoomMap onMapReady); null until it has loaded. */
  map: MapLibreMap | null;
  children: ReactNode;
}

const MEASURING: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always, frequency: 100 },
};

const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

type Pt = { x: number; y: number };

/** Follow the pointer while a drag runs (the drop point; dnd-kit's delta can include scroll). */
function trackPointer(start: Pt | null): { last(): Pt | null; stop(): void } {
  let last = start;
  const onTouch = (e: TouchEvent) => {
    const t = e.touches[0] ?? e.changedTouches[0];
    if (t) last = { x: t.clientX, y: t.clientY };
  };
  const onMouse = (e: MouseEvent) => {
    last = { x: e.clientX, y: e.clientY };
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('touchmove', onTouch, opts);
  window.addEventListener('mousemove', onMouse, opts);
  return {
    last: () => last,
    stop() {
      window.removeEventListener('touchmove', onTouch, opts);
      window.removeEventListener('mousemove', onMouse, opts);
    },
  };
}

function dragData(active: { data: { current?: unknown } }): DragData | null {
  const d = active.data.current as DragData | undefined;
  return d?.kind === 'job' ? d : null;
}

function dropData(over: { data: { current?: unknown } } | null): DropData | null {
  return (over?.data.current as DropData | undefined) ?? null;
}

export function WorkBoardProvider({ variant, map, children }: WorkBoardProviderProps) {
  const [store] = useState(() =>
    createBoardStore({ api: createBoardApi((input, init) => fetch(input, init)) }),
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES }),
  );
  const mapRef = useRef(map);
  mapRef.current = map;
  const drag = useRef<{
    pointer: ReturnType<typeof trackPointer>;
    restore: () => void;
    hoverFrame: number | null;
    hoverField: string | null;
  } | null>(null);
  const [overTarget, setOverTarget] = useState(false);
  const [hoverField, setHoverField] = useState<string | null>(null);

  const endDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (d) {
      d.pointer.stop();
      d.restore();
      if (d.hoverFrame !== null) cancelAnimationFrame(d.hoverFrame);
    }
    const m = mapRef.current;
    if (m) {
      try {
        removeDropHover(m);
      } catch {
        // The style is reloading or the map is going away.
      }
    }
    setOverTarget(false);
    setHoverField(null);
    store.getState().dragEnd();
  }, [store]);

  // A drag still running when the board goes away (navigation) gives the map its gestures back.
  useEffect(() => () => endDrag(), [endDrag]);

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      const data = dragData(e.active);
      if (!data) return;
      const m = mapRef.current;
      const restore = m ? suspendMapGestures(m) : () => {};
      if (m) {
        try {
          showDropHover(m, null, variant === 'wall');
        } catch {
          // No style yet: no highlight.
        }
      }
      drag.current = {
        pointer: trackPointer(getEventCoordinates(e.activatorEvent)),
        restore,
        hoverFrame: null,
        hoverField: null,
      };
      // The wall's job popover would cover the top of the map (where the card may go); a form
      // being filled in (Edit, New job) stays.
      const ui = useWorkBoardUi.getState();
      const form =
        ui.detail?.kind === 'new' || (ui.detail?.kind === 'job' && ui.detail.mode === 'edit');
      if (variant === 'wall' && !form) closeWorkBoardOverlays();
      store.getState().dragStart(data.jobId);
    },
    [store, variant],
  );

  const onDragMove = useCallback(
    (_e: DragMoveEvent) => {
      const d = drag.current;
      const m = mapRef.current;
      if (!d || !m || d.hoverFrame !== null) return;
      // Once a frame, the field under the finger (only when it is on the map's canvas).
      d.hoverFrame = requestAnimationFrame(() => {
        d.hoverFrame = null;
        if (drag.current !== d) return;
        const p = d.pointer.last();
        const point = p ? mapPointAt(m, p, document) : null;
        const fieldId = point ? fieldAt(m, point) : null;
        if (fieldId === d.hoverField) return;
        d.hoverField = fieldId;
        setHoverField(fieldId);
        try {
          showDropHover(m, fieldId, variant === 'wall');
        } catch {
          // The style is reloading.
        }
      });
    },
    [variant],
  );

  const onDragOver = useCallback((e: DragOverEvent) => {
    const kind = dropData(e.over)?.kind;
    setOverTarget(kind === 'machine' || kind === 'person' || kind === 'map');
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const data = dragData(e.active);
      const pointer = drag.current?.pointer.last() ?? null;
      endDrag();
      if (!data) return;
      // A finger or the mouse: what is under it now. The keyboard: dnd-kit's `over`.
      let at: PointTarget;
      if (pointer) {
        at = targetAt(document, pointer);
      } else {
        const over = dropData(e.over);
        at =
          over?.kind === 'machine' || over?.kind === 'person' || over?.kind === 'map'
            ? over
            : { kind: 'none' };
      }
      // Test seam: an e2e spec may set `window.__workBoardDrops = []` to see how drops resolve.
      const log = (window as { __workBoardDrops?: unknown[] }).__workBoardDrops;
      log?.push({ pointer, at, over: e.over?.id ?? null });
      const translated = e.active.rect.current.translated;
      const point =
        pointer ??
        (translated
          ? { x: translated.left + translated.width / 2, y: translated.top + translated.height / 2 }
          : null);
      let target: DropTarget | null = null;
      if (at.kind === 'machine') target = { kind: 'machine', machineId: at.machineId };
      else if (at.kind === 'person') target = { kind: 'person', partyId: at.partyId };
      else if (at.kind === 'map' && point && mapRef.current) {
        const res = resolveMapDrop(mapRef.current, point, document);
        if (res.kind === 'field') target = { kind: 'field', fieldId: res.fieldId };
        else if (res.kind === 'point') target = { kind: 'point', lngLat: res.lngLat };
        else if (res.reason === 'no_field') {
          store.getState().say('info', 'Drop the card inside a field to put the job there');
        }
      }
      if (target) void store.getState().drop(data.jobId, target);
    },
    [endDrag, store],
  );

  const onDragCancel = useCallback((_e: DragCancelEvent) => endDrag(), [endDrag]);

  const announcements = useMemo<Announcements>(() => {
    const jobName = (id: unknown) => {
      const jobId = typeof id === 'string' && id.startsWith('work:job:') ? id.slice(9) : null;
      return (jobId && findJob(store.getState().snapshot, jobId)?.summary) || 'the job';
    };
    const targetName = (over: { data: { current?: unknown } } | null) => {
      const d = dropData(over);
      if (!d) return null;
      if (d.kind === 'map') return 'the map';
      if (d.kind === 'machine' || d.kind === 'person') {
        const el = document.querySelector(
          d.kind === 'machine'
            ? `[data-testid="chip-machine"][data-machine-id="${d.machineId}"]`
            : `[data-testid="chip-person"][data-party-id="${d.partyId}"]`,
        );
        return el?.getAttribute('aria-label') ?? (d.kind === 'machine' ? 'a machine' : 'a person');
      }
      return null;
    };
    return {
      onDragStart: ({ active }) => `Picked up ${jobName(active.id)}.`,
      onDragOver: ({ active, over }) => {
        const t = targetName(over);
        return t ? `${jobName(active.id)} is over ${t}.` : `${jobName(active.id)} is over nothing.`;
      },
      onDragEnd: ({ active, over }) => {
        const t = targetName(over);
        return t ? `Dropped ${jobName(active.id)} on ${t}.` : `${jobName(active.id)} was put back.`;
      },
      onDragCancel: ({ active }) => `${jobName(active.id)} was put back.`,
    };
  }, [store]);

  return (
    <BoardStoreContext.Provider value={store}>
      <DndContext
        id={`work-board-${variant}`}
        sensors={sensors}
        collisionDetection={chipsFirst}
        autoScroll={false}
        measuring={MEASURING}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To move a job, press Space on its grip, use the arrow keys to move it over a ' +
              'machine or a person, then press Space to drop it, or Escape to put it back.',
          },
        }}
      >
        {children}
        <MapDropZone map={map} hoverField={hoverField} />
        <DragOverlay
          zIndex={DRAG_OVERLAY_Z_INDEX}
          className={css.overlay}
          dropAnimation={overTarget ? null : defaultDropAnimation}
        >
          <DraggedCard variant={variant} />
        </DragOverlay>
      </DndContext>
    </BoardStoreContext.Provider>
  );
}

/** The card under the finger (a copy of the dragged one; the original stays dimmed in place). */
function DraggedCard({ variant }: { variant: MapVariant }) {
  const job = useBoard((s) => (s.dragging ? findJob(s.snapshot, s.dragging.jobId) : null));
  return job ? <OverlayCard job={job} variant={variant} /> : null;
}

/**
 * The map's drop zone: a droppable covering the map's container (rendered into it, under the
 * map's own controls; it lets every pointer event through, so map gestures never notice it).
 */
function MapDropZone({ map, hoverField }: { map: MapLibreMap | null; hoverField: string | null }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: MAP_DROP_ID,
    data: { kind: 'map' } satisfies DropData,
  });
  const container = map?.getContainer() ?? null;
  if (!container) return null;
  return createPortal(
    <div
      ref={setNodeRef}
      className={css.mapDrop}
      data-testid="jobs-map-drop"
      data-dragging={active ? 'true' : 'false'}
      data-over={isOver ? 'true' : 'false'}
      data-hover-field={hoverField ?? ''}
      aria-hidden="true"
    />,
    container,
  );
}
