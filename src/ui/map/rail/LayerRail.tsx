'use client';
/**
 * The layer rail down the left side of /board (and a drawer on /m): touch-friendly toggles in
 * rail order (fields; soils; elevation and drainage; imagery; tile maps; parcels; live fleet;
 * custom-work customers), plan 1d. Owner: soils. Contract: ../layers/types.ts and
 * docs/contracts-m1.md §7, §12 (`<LayerRail map variant />`).
 *
 *  - Rows: GET /api/layers (./feed.ts), refreshed on realtime `layers`/`updated`; drawing: the
 *    code's LayerDefs (../layers/registry.ts), joined by resolveLayers.
 *  - Visibility lives in the shared zustand store (../layers/visibility.ts); the board's fleet
 *    reads `useLayerVisible('fleet', true)`. Choices and open/closed are remembered per device
 *    (./persist.ts, localStorage, every access guarded).
 *  - The map is kept in step with applyLayers on every change and after each style reload
 *    ('styledata', coalesced to one apply per frame).
 *  - Online-only layers say "offline" when the browser is offline or their tiles fail (the WAN
 *    can be down while the LAN is up), and come back when a tile loads again.
 *  - A layer drawn more than one way (./modes.ts: the soils colour-by modes) shows a mode picker
 *    under its toggle while on; the choice is remembered with the rest, its legend follows it,
 *    and after every applyLayers the layer paints itself for the mode (no tile refetch).
 *  - Soils also get their label points (../../soils/useSoilLabels.ts) and, under the legend,
 *    the map units in view (./SoilsInView.tsx).
 *
 * Wall: 72 px targets; phone: 52 px.
 */
import type {
  ErrorEvent as MapErrorEvent,
  Map as MapLibreMap,
  MapSourceDataEvent,
} from 'maplibre-gl';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicConfig } from '../../../config';
import type { LayerLegend, ResolvedMapLayer } from '../../../domain/map-layers';
import { installSoilsTestApi } from '../../soils/test-api';
import { useSoilLabels } from '../../soils/useSoilLabels';
import { applyLayers } from '../layers/apply';
import { LAYER_DEFS } from '../layers/registry';
import { SOILS_LAYER_KEY } from '../layers/soils';
import { type LayerDef, resolveLayers } from '../layers/types';
import { useLayerVisibilityStore } from '../layers/visibility';
import type { BasemapFlavor, MapVariant } from '../types';
import { railRealtime, startLayersFeed } from './feed';
import { layerKeyOfSource, type RailItem, railModel } from './model';
import { LAYER_MODES, layerModeOf, useLayerModeStore } from './modes';
import { browserStorage, loadRailPrefs, saveRailPrefs } from './persist';
import css from './rail.module.css';
import { SoilsInView } from './SoilsInView';

/** The map type the rail takes (what WarRoomMap's onMapReady hands over). */
export type RailMap = MapLibreMap;

export interface LayerRailProps {
  /** The board's map (WarRoomMap onMapReady); null until it has loaded. */
  map: MapLibreMap | null;
  variant: MapVariant;
  /**
   * Realtime adapter for `layers` updates (publicConfig); default local SSE. With an appEnv
   * other than production, the soils test view (window.__soils) is installed.
   */
  config?: Pick<PublicConfig, 'realtime'> & Partial<Pick<PublicConfig, 'appEnv'>>;
  /** Basemap flavour the layers are styled for (default: dark on the wall, light on phones). */
  flavor?: BasemapFlavor;
  /** The defs to offer (tests); default LAYER_DEFS. */
  defs?: readonly LayerDef[];
  /** The rail opened or closed (the board shows the map's own legend only while it is closed). */
  onOpenChange?(open: boolean): void;
}

/** Everything applyLayers needs besides the map. */
interface ApplyState {
  resolved: ReturnType<typeof resolveLayers>;
  overrides: Readonly<Record<string, boolean>>;
  modes: Readonly<Record<string, string>>;
  loaded: boolean;
  flavor: BasemapFlavor;
}

const DEFAULT_CONFIG: NonNullable<LayerRailProps['config']> = { realtime: 'sse' };

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () =>
      setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Layer keys whose tiles are failing (map 'error' on a `layer:` source), cleared on a good tile. */
function useFailingLayers(map: MapLibreMap | null): ReadonlySet<string> {
  const [failing, setFailing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!map) return;
    // Source errors carry the source id (MapLibre adds it to every source event).
    const onError = (e: MapErrorEvent) => {
      const key = layerKeyOfSource((e as MapErrorEvent & { sourceId?: string }).sourceId);
      if (key) setFailing((s) => (s.has(key) ? s : new Set([...s, key])));
    };
    const onSourceData = (e: MapSourceDataEvent) => {
      const key = layerKeyOfSource(e.sourceId);
      if (key && e.tile) {
        setFailing((s) => {
          if (!s.has(key)) return s;
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    };
    map.on('error', onError);
    map.on('sourcedata', onSourceData);
    return () => {
      map.off('error', onError);
      map.off('sourcedata', onSourceData);
    };
  }, [map]);
  return failing;
}

function useZoom(map: MapLibreMap | null): number | null {
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    if (!map) return;
    const update = () => setZoom(Math.round(map.getZoom() * 100) / 100);
    update();
    map.on('zoomend', update);
    return () => {
      map.off('zoomend', update);
    };
  }, [map]);
  return zoom;
}

function Legend({ legend, testId, mode }: { legend: LayerLegend; testId: string; mode?: string }) {
  return (
    <div className={css.legend} data-testid={testId} data-mode={mode}>
      {legend.title && <div className={css.legendTitle}>{legend.title}</div>}
      {legend.items.map((it) => (
        <div key={it.label} className={css.legendRow}>
          <span
            className={`${css.swatch} ${it.swatch === 'line' ? css.swatchLine : it.swatch === 'point' ? css.swatchPoint : ''}`}
            style={
              it.swatch === 'ramp' && it.colors
                ? { background: `linear-gradient(90deg, ${it.colors.join(', ')})` }
                : it.swatch === 'line'
                  ? { borderColor: it.color }
                  : { background: it.color }
            }
          />
          {it.label}
        </div>
      ))}
      {legend.note && <div className={css.legendNote}>{legend.note}</div>}
    </div>
  );
}

function ModePicker({ item, onMode }: { item: RailItem; onMode(key: string, mode: string): void }) {
  if (!item.mode) return null;
  const { options, current } = item.mode;
  return (
    <fieldset className={css.modes} data-testid={`layer-modes-${item.key}`}>
      <legend className={css.modesLegend}>Show by</legend>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === current}
          className={`${css.mode} ${o.id === current ? css.modeOn : ''}`}
          onClick={() => onMode(item.key, o.id)}
          data-testid={`layer-mode-${item.key}-${o.id}`}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

function Toggle({
  item,
  onToggle,
  onMode,
  children,
}: {
  item: RailItem;
  onToggle(item: RailItem): void;
  onMode(key: string, mode: string): void;
  children?: ReactNode;
}) {
  const status = item.zoomHint ?? item.message;
  return (
    <div className={css.entry}>
      <button
        type="button"
        className={`${css.item} ${item.on ? css.itemOn : ''}`}
        aria-pressed={item.on}
        disabled={!item.toggleable}
        onClick={() => onToggle(item)}
        data-testid={`layer-toggle-${item.key}`}
        data-status={item.status}
      >
        <span className={css.switch} aria-hidden="true" />
        <span className={css.itemText}>
          <span className={css.itemLabel}>{item.label}</span>
          {status && (
            <span
              className={`${css.status} ${item.status === 'offline' ? css.statusOffline : item.status === 'ready' ? css.statusHint : ''}`}
              data-testid={`layer-status-${item.key}`}
            >
              {item.status === 'offline' ? 'offline' : status}
            </span>
          )}
        </span>
      </button>
      <ModePicker item={item} onMode={onMode} />
      {item.legend && item.legend.items.length > 0 && (
        <Legend
          legend={item.legend}
          testId={`layer-legend-${item.key}`}
          mode={item.mode?.current}
        />
      )}
      {children}
      {item.on && item.source && (
        <div className={`${css.source} ${item.synthetic ? css.sourceWarn : ''}`}>{item.source}</div>
      )}
    </div>
  );
}

export function LayerRail({
  map,
  variant,
  config = DEFAULT_CONFIG,
  flavor,
  defs = LAYER_DEFS,
  onOpenChange,
}: LayerRailProps) {
  const effectiveFlavor: BasemapFlavor = flavor ?? (variant === 'wall' ? 'dark' : 'light');
  const [rows, setRows] = useState<ResolvedMapLayer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(variant === 'wall');
  const [hydrated, setHydrated] = useState(false);
  const overrides = useLayerVisibilityStore((s) => s.overrides);
  const modes = useLayerModeStore((s) => s.modes);
  const online = useOnline();
  const failing = useFailingLayers(map);
  const zoom = useZoom(map);

  // Restore this device's choices once, then save every change.
  useEffect(() => {
    const prefs = loadRailPrefs(browserStorage(), variant);
    useLayerVisibilityStore.getState().hydrate(prefs.overrides);
    useLayerModeStore.getState().hydrate(prefs.modes);
    if (prefs.open !== null) setOpen(prefs.open);
    setHydrated(true);
  }, [variant]);
  useEffect(() => {
    if (!hydrated) return;
    saveRailPrefs(browserStorage(), variant, { overrides, modes, open });
  }, [hydrated, variant, overrides, modes, open]);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // The registry, live.
  useEffect(() => {
    const realtime = railRealtime(config);
    return startLayersFeed({
      realtime,
      onLayers: (layers) => {
        setRows(layers);
        setLoaded(true);
      },
      onError: setError,
    });
  }, [config]);

  const resolved = useMemo(() => resolveLayers(defs, rows), [defs, rows]);

  // Keep the map in step: on every change (the effect names everything apply reads, so a lint
  // fix can't drop a dependency), and after style reloads (one apply per frame, latest state).
  const apply = useCallback(
    (state: ApplyState) => {
      if (!map || !state.loaded) return;
      const ctx = { flavor: state.flavor, variant };
      try {
        applyLayers(map, state.resolved, (key, def) => state.overrides[key] ?? def, {
          origin: window.location.origin,
          ...ctx,
        });
        // Layers with modes paint themselves for the chosen one (paint only: no refetch).
        for (const r of state.resolved) {
          const modesOf = LAYER_MODES[r.def.key];
          const mode = layerModeOf(state.modes, r.def.key);
          if (modesOf && mode !== null && r.status === 'ready') modesOf.apply(map, mode, ctx);
        }
      } catch (e) {
        console.error('[layer rail] could not apply layers', e);
      }
    },
    [map, variant],
  );
  const latest = useRef<ApplyState>({
    resolved,
    overrides,
    modes,
    loaded,
    flavor: effectiveFlavor,
  });
  latest.current = { resolved, overrides, modes, loaded, flavor: effectiveFlavor };
  useEffect(() => {
    apply({ resolved, overrides, modes, loaded, flavor: effectiveFlavor });
  }, [apply, resolved, overrides, modes, loaded, effectiveFlavor]);

  // Test-only window.__soils (paint, filters, draw order).
  const appEnv = config.appEnv;
  useEffect(() => {
    if (!map || !appEnv || appEnv === 'production') return;
    return installSoilsTestApi(map);
  }, [map, appEnv]);

  // Soils: one label point per polygon, while the layer is drawn.
  const soils = resolved.find((r) => r.def.key === SOILS_LAYER_KEY);
  useSoilLabels(map, {
    enabled:
      soils?.status === 'ready' && (overrides[SOILS_LAYER_KEY] ?? soils.defaultVisible) && loaded,
    version: soils?.row?.version ?? null,
  });
  useEffect(() => {
    if (!map) return;
    let frame = 0;
    const onStyle = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply(latest.current);
      });
    };
    map.on('styledata', onStyle);
    return () => {
      map.off('styledata', onStyle);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [map, apply]);

  const groups = useMemo(
    () =>
      railModel({
        resolved,
        overrides,
        loaded,
        online,
        failing,
        zoom,
        modes,
        flavor: effectiveFlavor,
        variant,
      }),
    [resolved, overrides, loaded, online, failing, zoom, modes, effectiveFlavor, variant],
  );
  const toggle = useCallback((item: RailItem) => {
    useLayerVisibilityStore.getState().toggle(item.key, item.defaultVisible);
  }, []);
  const setMode = useCallback((key: string, mode: string) => {
    useLayerModeStore.getState().setMode(key, mode);
  }, []);
  const reset = useCallback(() => {
    useLayerVisibilityStore.getState().reset();
    useLayerModeStore.getState().reset();
  }, []);
  const changed = Object.keys(overrides).length > 0 || Object.keys(modes).length > 0;

  return (
    <div
      className={`${css.rail} ${variant === 'phone' ? css.phone : ''} ${open ? css.railOpen : ''}`}
      data-testid="layer-rail-root"
    >
      {!open && (
        <button
          type="button"
          className={css.opener}
          aria-expanded={false}
          aria-controls="layer-rail"
          aria-label="Show map layers"
          onClick={() => setOpen(true)}
          data-testid="layer-rail-toggle"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 2 8l10 5 10-5-10-5Z" fill="currentColor" opacity="0.9" />
            <path
              d="m2 12 10 5 10-5M2 16l10 5 10-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          {variant === 'wall' && <span>Layers</span>}
        </button>
      )}
      {open && (
        <section
          id="layer-rail"
          className={css.panel}
          aria-label="Map layers"
          data-testid="layer-rail"
          data-dock={variant === 'wall' ? 'left' : undefined}
        >
          <header className={css.header}>
            <span className={css.title}>Layers</span>
            {changed && (
              <button
                type="button"
                className={css.reset}
                onClick={reset}
                data-testid="layer-rail-reset"
              >
                Defaults
              </button>
            )}
            <button
              type="button"
              className={css.close}
              aria-expanded={true}
              aria-controls="layer-rail"
              aria-label="Hide map layers"
              onClick={() => setOpen(false)}
              data-testid="layer-rail-toggle"
            >
              ×
            </button>
          </header>
          {error && (
            <div className={css.error} role="status" data-testid="layer-rail-error">
              Layer list unavailable; retrying. {loaded ? 'Showing the last one.' : ''}
            </div>
          )}
          {!online && (
            <div className={css.offline} role="status" data-testid="layer-rail-offline">
              Offline: local layers keep working; online imagery is unavailable.
            </div>
          )}
          <div className={css.groups}>
            {groups.map((g) => (
              <div key={g.group} className={css.group} data-testid={`layer-group-${g.group}`}>
                <div className={css.groupTitle}>{g.label}</div>
                {g.items.map((item) => (
                  <Toggle key={item.key} item={item} onToggle={toggle} onMode={setMode}>
                    {item.key === SOILS_LAYER_KEY && item.mode && (
                      <SoilsInView
                        map={map}
                        mode={item.mode.current}
                        flavor={effectiveFlavor}
                        zoom={zoom}
                      />
                    )}
                  </Toggle>
                ))}
                {g.hint && <div className={css.hint}>{g.hint}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default LayerRail;
