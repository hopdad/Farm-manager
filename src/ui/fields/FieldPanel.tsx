'use client';
/**
 * The field panel (plan 1a "tap a field"; docs/contracts-m1.md §8, §12): what opens when a field
 * is tapped on /board (wall) or /m (phone).
 *
 *   <FieldPanel fieldId={id} variant="wall" config={data.config} map={map} onClose={…} />
 *
 *  - Wall: a side panel over the map's right side, 72 px touch targets, large type; closes with
 *    the big X, Escape, or a tap on empty map (the board passes WarRoomMap's onFieldTap(null)).
 *  - Phone: a bottom sheet with a drag handle and three snap heights (./sheet.ts); drag it down
 *    past the lowest to close, or use the X / Escape. The handle also works by keyboard.
 *  - Loads one FieldDetail (GET /api/fields/<id>, ./useFieldDetail.ts) and renders the tabs of
 *    the registry (./tab-registry.ts) in order; realtime `fields`/`updated` keeps it current.
 *  - With the board's map (WarRoomMap onMapReady): the boundary is highlighted, moved into view
 *    when the panel or the screen edge hides it, and the header fills from the loaded tiles at
 *    once while the detail loads.
 *  - Marks `field-panel:open` and `field-panel:ready` (User Timing, detail `{ fieldId }`) so the
 *    e2e suite measures tap → panel against the 200 ms budget.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  Component,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FieldPart } from '../../domain/fields';
import { TENURE_COLORS, TENURE_LABELS } from '../map/style';
import { markTiming } from './detail-loader';
import css from './field-panel.module.css';
import {
  applyHighlight,
  needsReveal,
  type PanelVariant,
  panelPadding,
  removeHighlight,
  tilePreview,
} from './highlight';
import {
  clampDrag,
  SHEET_OPEN_SNAP,
  type SheetSnap,
  SNAP_LABELS,
  settleSnap,
  snapHeights,
  stepSnap,
  toggleSnap,
} from './sheet';
import { FIELD_PANEL_TABS } from './tab-registry';
import { type FieldPanelConfig, useFieldDetail } from './useFieldDetail';
import { formatAcres } from './view-model';
import { visibleTabs } from './visible-tabs';

/** The board's map, as WarRoomMap's onMapReady hands it over. */
export type FieldPanelMap = MapLibreMap;

export interface FieldPanelProps {
  fieldId: string;
  variant: PanelVariant;
  onClose(): void;
  /** publicConfig(): the realtime adapter (and appEnv, for the e2e realtime seam). */
  config: FieldPanelConfig;
  /** The board's map, for the highlight; optional (the panel works without it). */
  map?: FieldPanelMap | null;
}

/** The tab last chosen, per variant, for this tab's lifetime (it stays across fields). */
const lastTab: Record<PanelVariant, string | undefined> = { wall: undefined, phone: undefined };

export function FieldPanel({ fieldId, variant, onClose, config, map = null }: FieldPanelProps) {
  const { state, refetch } = useFieldDetail(fieldId, config);
  const detail = state.detail;
  const rootRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const tabsId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const tabs = useMemo(
    () => visibleTabs(FIELD_PANEL_TABS, state.role, detail),
    [state.role, detail],
  );
  const [tabId, setTabId] = useState<string | undefined>(() => lastTab[variant]);
  const active = tabs.find((t) => t.id === tabId) ?? tabs[0];
  const selectTab = (id: string) => {
    setTabId(id);
    lastTab[variant] = id;
  };

  const preview = useMemo(() => (map ? tilePreview(map, fieldId) : null), [map, fieldId]);

  // The highlight waits for the panel's data (or 300 ms): adding map layers costs a full map
  // frame, which on a weak GPU would otherwise land between the response and its render.
  const settled = useSettled(fieldId, state.status !== 'loading', HIGHLIGHT_FALLBACK_MS);
  useHighlight(map, settled ? fieldId : null, variant);
  useReveal(map, fieldId, detail?.boundary?.bbox ?? null, rootRef, variant);
  usePerfMarks(fieldId, state.status === 'ready' && detail !== null);

  // Each newly opened field moves focus to its title (screen readers announce it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fieldId is the trigger.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [fieldId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onChanged = useCallback((_parts: FieldPart[]) => refetch(), [refetch]);

  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active?.id);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    const tab = tabs[next];
    if (next < 0 || !tab) return;
    e.preventDefault();
    selectTab(tab.id);
    document.getElementById(`${tabsId}-tab-${tab.id}`)?.focus();
  };

  const tenure = detail?.field.tenure ?? preview?.tenure ?? null;
  const acres = detail ? formatAcres(detail.field.acres) : formatAcres(preview?.acres ?? null);
  const title =
    detail?.field.name ??
    preview?.name ??
    (state.status === 'not_found'
      ? 'Field not found'
      : state.status === 'loading'
        ? 'Loading field…'
        : 'Field');

  const header = (
    <header className={css.header}>
      <div>
        <h2
          ref={headingRef}
          id={titleId}
          className={css.title}
          tabIndex={-1}
          data-testid="field-panel-title"
        >
          {title}
        </h2>
        <div className={css.meta}>
          {acres && (
            <span className={css.acres} data-testid="field-acres">
              {acres}
            </span>
          )}
          {tenure && (
            <span className={css.chip} data-testid="field-tenure">
              <span className={css.swatch} style={{ color: TENURE_COLORS[tenure] }} />
              {TENURE_LABELS[tenure]}
            </span>
          )}
          {detail && (
            <span data-testid="field-farm">
              <span className={css.label}>Farm</span> {detail.field.farmName}
              {detail.field.customer ? ` · for ${detail.field.customer.displayName}` : ''}
            </span>
          )}
          {detail && !detail.field.active && <span className={css.badge}>Inactive</span>}
        </div>
      </div>
      <button
        type="button"
        className={css.close}
        aria-label="Close field panel"
        onClick={() => onCloseRef.current()}
        data-testid="field-panel-close"
      >
        ×
      </button>
    </header>
  );

  const body = (() => {
    if (state.status === 'not_found') {
      return <p className={css.empty}>This field is no longer in the records.</p>;
    }
    if (state.status === 'denied') {
      return <p className={css.empty}>Sign in to see this field.</p>;
    }
    if (state.status === 'error' && !detail) {
      return (
        <div className={css.message} role="alert">
          <p>Couldn’t load this field ({state.error ?? 'unknown error'}).</p>
          <button type="button" className={css.button} onClick={refetch}>
            Try again
          </button>
        </div>
      );
    }
    if (!active) return null;
    return (
      <TabBoundary key={`${fieldId}:${active.id}`} label={active.label}>
        <active.Component
          fieldId={fieldId}
          detail={detail}
          variant={variant}
          role={state.role}
          onChanged={onChanged}
        />
      </TabBoundary>
    );
  })();

  const content = (
    <>
      {state.error && detail && (
        <p className={css.note} role="status">
          Couldn’t refresh ({state.error}); showing the last copy.
        </p>
      )}
      {tabs.length > 0 && (
        <div role="tablist" aria-label="Field details" className={css.tabs} onKeyDown={onTabKey}>
          {tabs.map((t) => {
            const selected = t.id === active?.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${tabsId}-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`${tabsId}-panel`}
                tabIndex={selected ? 0 : -1}
                className={css.tab}
                onClick={() => selectTab(t.id)}
                data-testid={`field-tab-${t.id}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={active ? `${tabsId}-tab-${active.id}` : titleId}
        className={css.body}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tab panel must be reachable by keyboard.
        tabIndex={0}
        data-testid={active ? `field-tabpanel-${active.id}` : 'field-tabpanel'}
      >
        {body}
      </div>
    </>
  );

  const data = {
    'data-testid': 'field-panel',
    'data-variant': variant,
    'data-field-id': fieldId,
    'data-state': state.status,
  };

  if (variant === 'phone') {
    return (
      <Sheet
        rootRef={rootRef}
        labelledBy={titleId}
        data={data}
        header={header}
        onClose={() => onCloseRef.current()}
      >
        {content}
      </Sheet>
    );
  }
  return (
    <aside
      ref={rootRef}
      className={`${css.panel} ${css.wall}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      {...data}
    >
      {header}
      {content}
    </aside>
  );
}

/** The phone bottom sheet: drag handle + header on top, snap heights from ./sheet.ts. */
function Sheet(props: {
  rootRef: RefObject<HTMLElement | null>;
  labelledBy: string;
  data: Record<string, string>;
  header: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  const { rootRef, onClose } = props;
  const [snap, setSnap] = useState<SheetSnap>(SHEET_OPEN_SNAP);
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  const [dragging, setDragging] = useState(false);
  const heights = useMemo(() => snapHeights(viewportH), [viewportH]);
  const drag = useRef<{
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

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setVisible = useCallback(
    (h: number) => rootRef.current?.style.setProperty('--sheet-visible', `${Math.round(h)}px`),
    [rootRef],
  );
  // After every commit that settles the sheet (snap, size, end of a drag), so the CSS transition
  // animates to the snap height once the `dragging` class is gone.
  useLayoutEffect(() => {
    if (dragging) return;
    rootRef.current?.style.setProperty('--sheet-full', `${heights.full}px`);
    setVisible(heights[snap]);
  }, [dragging, heights, snap, rootRef, setVisible]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('a, input, textarea, select, button:not([data-sheet-handle])')) return;
    drag.current = {
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
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;
      d.moved = true;
      setDragging(true);
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
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (!d.moved) return; // a tap: the handle's click does it
    suppressClick.current = true;
    const to = e.type === 'pointercancel' ? snap : settleSnap(heights, d.h, d.v);
    setDragging(false);
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

  return (
    <section
      ref={(el) => {
        rootRef.current = el;
      }}
      className={`${css.panel} ${css.phone} ${dragging ? css.dragging : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={props.labelledBy}
      data-snap={snap}
      {...props.data}
    >
      <div
        className={css.grab}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <button
          type="button"
          className={css.handle}
          data-sheet-handle
          data-testid="field-sheet-handle"
          aria-label={`Resize field panel (now ${SNAP_LABELS[snap]}); arrow keys work too`}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setSnap(toggleSnap);
          }}
          onKeyDown={onHandleKey}
        >
          <span className={css.grip} />
        </button>
        {props.header}
      </div>
      {props.children}
    </section>
  );
}

/** One broken tab (another builder's) must not take the panel down. */
class TabBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[field panel] the ${this.props.label} tab failed`, error, info.componentStack);
  }
  override render() {
    return this.state.failed ? (
      <p className={css.empty} role="alert">
        The {this.props.label} tab couldn’t be shown.
      </p>
    ) : (
      this.props.children
    );
  }
}

/** Highlight anyway after this long when the detail is slow (a phone on weak Wi-Fi). */
const HIGHLIGHT_FALLBACK_MS = 300;

/** True once `done` (for this `key`), or `ms` after the key changed. */
function useSettled(key: string, done: boolean, ms: number): boolean {
  const [timedOut, setTimedOut] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return done || timedOut === key;
}

/** Keep the open field highlighted on the map (re-applied after a style reload). */
function useHighlight(
  map: FieldPanelMap | null,
  fieldId: string | null,
  variant: PanelVariant,
): void {
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      try {
        applyHighlight(map, fieldId, variant);
      } catch {
        // The style is reloading; the next 'styledata' puts it back.
      }
    };
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
      try {
        removeHighlight(map);
      } catch {
        // The map is going away.
      }
    };
  }, [map, fieldId, variant]);
}

/** Once per opened field: move the map if the panel or the screen edge hides the boundary. */
function useReveal(
  map: FieldPanelMap | null,
  fieldId: string,
  bbox: [number, number, number, number] | null,
  rootRef: RefObject<HTMLElement | null>,
  variant: PanelVariant,
): void {
  const revealed = useRef<string | null>(null);
  const key = bbox ? bbox.join(',') : null;
  useEffect(() => {
    if (!map || !key || revealed.current === fieldId) return;
    revealed.current = fieldId;
    const [w, s, e, n] = key.split(',').map(Number) as [number, number, number, number];
    try {
      const container = map.getContainer().getBoundingClientRect();
      const panel = rootRef.current?.getBoundingClientRect() ?? null;
      const padding = panelPadding(container, panel, variant);
      const corners = [
        [w, s],
        [e, n],
        [w, n],
        [e, s],
      ].map(([lng, lat]) => map.project([lng as number, lat as number]));
      if (!needsReveal(container, padding, corners)) return;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding, maxZoom: map.getZoom(), duration: 600 },
      );
    } catch {
      // A map mid-teardown; nothing to reveal.
    }
  }, [map, fieldId, key, rootRef, variant]);
}

/**
 * User Timing marks the e2e suite reads (tap → panel within 200 ms): `field-panel:open` when the
 * panel is in the DOM, `field-panel:ready` when the field's data is (both at commit, before the
 * browser paints); ./detail-loader.ts adds `field-panel:data` when the response is parsed.
 */
function usePerfMarks(fieldId: string, ready: boolean): void {
  const markedReady = useRef<string | null>(null);
  useLayoutEffect(() => {
    markTiming('field-panel:open', fieldId);
  }, [fieldId]);
  useLayoutEffect(() => {
    if (!ready || markedReady.current === fieldId) return;
    markedReady.current = fieldId;
    markTiming('field-panel:ready', fieldId);
  }, [fieldId, ready]);
}
