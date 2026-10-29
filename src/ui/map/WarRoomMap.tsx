'use client';
/**
 * WarRoomMap: the war-room map shell (plan §6 M0). react-map-gl (MapLibre 6) with one interleaved
 * deck.gl MapLibreOverlay; the local PMTiles basemap with local fonts and sprites; field fills
 * and outlines from /api/tiles/fields; the fleet as deck layers gliding between ticks.
 *
 * Touch-first: one-finger pan, pinch zoom and two-finger rotate are MapLibre's own handlers
 * (they accept synthetic, isTrusted=false touch events, which the e2e suite relies on); pitch is
 * off. Controls are 72 px on the wall and 52 px on phones.
 *
 * Load with next/dynamic and `ssr: false` (MapLibre needs `window` and WebGL2).
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Layer } from '@deck.gl/core';
import type { MapLibreOverlay } from '@deck.gl/maplibre';
import type { ErrorEvent as MapErrorEvent, Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MapLayerMouseEvent, type MapRef, Map as MapView } from 'react-map-gl/maplibre';
import { MACHINE_KINDS } from '../../domain/fleet';
import { formatDuration } from '../board/format';
import { DeckOverlay } from './DeckOverlay';
import { buildFleetLayers, PHONE_SIZES, WALL_SIZES } from './fleet/layers';
import type { FleetFrame, FleetModel } from './fleet/model';
import { machineNear } from './fleet/pick';
import { DOWN_COLOR, KIND_COLORS, KIND_LABELS, STALE_COLOR, STALE_RING_COLOR } from './fleet/style';
import type { FleetStatus } from './fleet/useFleet';
import { setupMapLibre } from './maplibre';
import { buildMapStyle, FIELD_LAYER_IDS, TENURE_COLORS, TENURE_LABELS } from './style';
import { installMapTestApi } from './test-api';
import type { BasemapFlavor, MapPageData, MapVariant } from './types';
import css from './war-room-map.module.css';

export interface WarRoomMapProps {
  data: MapPageData;
  variant: MapVariant;
  flavor: BasemapFlavor;
  fleet: FleetModel;
  fleetStatus: FleetStatus;
  selectedId: string | null;
  onSelect(id: string | null): void;
  showLegend?: boolean;
  /** Fly to a point (e.g. a machine picked from a list); a new `nonce` repeats the flight. */
  flyTo?: { lng: number; lat: number; nonce: number } | null;
  /**
   * The MapLibre map once its style has loaded, and null on unmount (M1: the layer rail adds its
   * layers with applyLayers, src/ui/map/layers/apply.ts; panels query features).
   */
  onMapReady?(map: MapLibreMap | null): void;
  /** Draw the deck.gl fleet (default true; the rail's 'fleet' toggle). */
  fleetVisible?: boolean;
  /**
   * A tap or click that picked no machine: the field under it (farm.fields.id from the fields
   * tiles), or null for empty map. Machines win when both are under the finger.
   */
  onFieldTap?(fieldId: string | null): void;
}

const MAX_ERRORS = 50;

export default function WarRoomMap(props: WarRoomMapProps) {
  const { data, variant, flavor, fleet, fleetStatus, selectedId, onSelect } = props;
  const maplib = useMemo(() => setupMapLibre(), []);
  const mapRef = useRef<MapRef>(null);
  const compassRef = useRef<SVGSVGElement>(null);
  const [overlay, setOverlay] = useState<MapLibreOverlay | null>(null);
  const [loaded, setLoaded] = useState(false);
  const errorsRef = useRef<string[]>([]);
  const framesRef = useRef<FleetFrame[]>([]);
  const layersRef = useRef<Layer[]>([]);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const fleetVisibleRef = useRef(props.fleetVisible !== false);
  fleetVisibleRef.current = props.fleetVisible !== false;
  const onMapReadyRef = useRef(props.onMapReady);
  onMapReadyRef.current = props.onMapReady;
  const onFieldTapRef = useRef(props.onFieldTap);
  onFieldTapRef.current = props.onFieldTap;

  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const mapStyle = useMemo(
    () =>
      buildMapStyle({
        origin,
        basemap: data.basemap,
        glyphsPath: data.glyphsPath,
        fields: data.fields,
        flavor,
      }),
    [origin, data.basemap, data.glyphsPath, data.fields, flavor],
  );
  const sizes = variant === 'wall' ? WALL_SIZES : PHONE_SIZES;

  // Fleet render loop: rebuild deck layers while machines glide or after any change.
  useEffect(() => {
    if (!overlay) return;
    let raf = 0;
    let drawnVersion = -1;
    let drawnSelected: string | null | undefined;
    let drawnVisible: boolean | undefined;
    let wasAnimating = false;
    const draw = () => {
      const now = performance.now();
      const animating = fleet.isAnimating(now);
      const visible = fleetVisibleRef.current;
      if (
        animating ||
        wasAnimating ||
        fleet.version !== drawnVersion ||
        selectedRef.current !== drawnSelected ||
        visible !== drawnVisible
      ) {
        const frames = fleet.frame(now);
        const layers = visible ? buildFleetLayers(frames, sizes, selectedRef.current) : [];
        overlay.setProps({ layers });
        framesRef.current = frames;
        layersRef.current = layers;
        drawnVersion = fleet.version;
        drawnSelected = selectedRef.current;
        drawnVisible = visible;
      }
      wasAnimating = animating;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [overlay, fleet, sizes]);

  // Hand the map to whoever composes layers on it (the rail), once loaded; null on unmount.
  useEffect(() => {
    if (!loaded) return;
    onMapReadyRef.current?.(mapRef.current?.getMap() ?? null);
    return () => onMapReadyRef.current?.(null);
  }, [loaded]);

  // Test-only window.__map.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!loaded || !map || data.config.appEnv === 'production') return;
    return installMapTestApi(map, {
      deckLayers: () =>
        layersRef.current.map((l) => ({
          id: l.id,
          data: Array.isArray(l.props.data) ? (l.props.data as unknown[]) : [],
        })),
      fleet: () => framesRef.current,
      errors: () => [...errorsRef.current],
    });
  }, [loaded, data.config.appEnv]);

  const flyTo = props.flyTo;
  useEffect(() => {
    const m = mapRef.current;
    if (!flyTo || !m || !loaded) return;
    m.flyTo({ center: [flyTo.lng, flyTo.lat], zoom: Math.max(m.getZoom(), 13), duration: 800 });
  }, [flyTo, loaded]);

  // Selection through MapLibre's click (fired for mouse clicks and touch taps alike), then a
  // deck pick at that point: deck's own onClick only sees mouse-down picks, not taps. The GPU
  // pick only runs when a machine is drawn near the tap (./fleet/pick.ts): it stalls the frame,
  // and most taps are field taps (the field panel's < 200 ms budget, plan 1a).
  const pickRadius = variant === 'wall' ? 14 : 10;
  const onClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const gl = mapRef.current?.getMap();
      const reach = sizes.ringRadiusPx + pickRadius + 8;
      const near =
        !!gl &&
        fleetVisibleRef.current &&
        machineNear(framesRef.current, (ll) => gl.project(ll), e.point, reach);
      const info = near
        ? overlay?.pickObject({
            x: e.point.x,
            y: e.point.y,
            radius: pickRadius,
            layerIds: ['fleet-halo', 'fleet-icons'],
          })
        : null;
      const picked = info?.object as FleetFrame | undefined;
      onSelect(picked ? picked.id : null);
      // A tap that hit no machine may be a field tap (the field panel, 1a).
      const onFieldTap = onFieldTapRef.current;
      if (!picked && onFieldTap) {
        const map = mapRef.current?.getMap();
        const hit = map?.getLayer(FIELD_LAYER_IDS.fill)
          ? map.queryRenderedFeatures([e.point.x, e.point.y], { layers: [FIELD_LAYER_IDS.fill] })
          : [];
        const id = hit[0]?.properties?.id;
        onFieldTap(typeof id === 'string' ? id : null);
      }
    },
    [overlay, onSelect, pickRadius, sizes],
  );

  const onError = useCallback((e: MapErrorEvent) => {
    const msg = e.error?.message ?? String(e);
    console.warn('[map]', msg);
    if (errorsRef.current.length < MAX_ERRORS) errorsRef.current.push(msg);
  }, []);

  const onRotate = useCallback(() => {
    const bearing = mapRef.current?.getBearing() ?? 0;
    if (compassRef.current) compassRef.current.style.transform = `rotate(${-bearing}deg)`;
  }, []);

  const map = () => mapRef.current;
  const home = () =>
    map()?.fitBounds(data.initialBounds as [number, number, number, number], {
      padding: variant === 'wall' ? 80 : 32,
      maxZoom: 15,
      bearing: 0,
      duration: 600,
    });

  const kindsPresent = MACHINE_KINDS.filter((k) => fleetStatus.machines.some((m) => m.kind === k));

  return (
    <div
      className={`${css.root} ${variant === 'phone' ? css.phone : ''}`}
      data-testid="war-room-map"
    >
      <MapView
        ref={mapRef}
        mapLib={maplib}
        mapStyle={mapStyle}
        initialViewState={{
          bounds: data.initialBounds as [number, number, number, number],
          fitBoundsOptions: { padding: variant === 'wall' ? 80 : 32, maxZoom: 15 },
        }}
        style={{ position: 'absolute', inset: 0 }}
        minZoom={5}
        maxZoom={19}
        maxPitch={0}
        dragRotate
        pitchWithRotate={false}
        touchPitch={false}
        touchZoomRotate
        renderWorldCopies={false}
        attributionControl={{ compact: true }}
        onLoad={() => setLoaded(true)}
        onError={onError}
        onRotate={onRotate}
        onClick={onClick}
      >
        <DeckOverlay onOverlay={setOverlay} />
      </MapView>

      <div className={css.badges} data-testid="map-badges">
        {!data.basemap && (
          <span
            className={`${css.badge} ${css.badgeWarn}`}
            title={data.basemapProblem ?? undefined}
            data-testid="badge-basemap-missing"
          >
            Basemap missing: run pnpm gis:basemap
          </span>
        )}
        {data.basemap?.synthetic && (
          <span className={`${css.badge} ${css.badgeInfo}`} data-testid="badge-basemap-synthetic">
            Synthetic test basemap
          </span>
        )}
        {!data.dbOk && (
          <span className={`${css.badge} ${css.badgeError}`} data-testid="badge-db">
            Database unavailable: fields not loaded
          </span>
        )}
        {fleetStatus.counts.stale > 0 && (
          <span className={`${css.badge} ${css.badgeWarn}`} data-testid="badge-stale">
            {fleetStatus.counts.stale} stale
          </span>
        )}
        {fleetStatus.connection === 'unavailable' && (
          <span
            className={`${css.badge} ${css.badgeError}`}
            title={fleetStatus.error ?? undefined}
            data-testid="badge-fleet-unavailable"
          >
            Fleet unavailable
          </span>
        )}
      </div>

      <div className={css.controls}>
        <button
          type="button"
          className={css.control}
          aria-label="Zoom in"
          onClick={() => map()?.zoomIn()}
        >
          +
        </button>
        <button
          type="button"
          className={css.control}
          aria-label="Zoom out"
          onClick={() => map()?.zoomOut()}
        >
          −
        </button>
        <button
          type="button"
          className={css.control}
          aria-label="Reset north"
          onClick={() => map()?.resetNorth({ duration: 400 })}
        >
          <svg ref={compassRef} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 L17 14 L12 11.5 L7 14 Z" fill="#ef4444" />
            <path d="M12 22 L7 10 L12 12.5 L17 10 Z" fill="#e7efe9" opacity="0.7" />
          </svg>
        </button>
        <button type="button" className={css.control} aria-label="Show all fields" onClick={home}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {props.showLegend !== false && (
        <div className={css.legend} data-testid="map-legend">
          <div className={css.legendTitle}>Fields</div>
          {(Object.keys(TENURE_COLORS) as (keyof typeof TENURE_COLORS)[]).map((t) => (
            <div key={t} className={css.legendRow}>
              <span
                className={css.swatch}
                style={{ borderColor: TENURE_COLORS[t], background: `${TENURE_COLORS[t]}55` }}
              />
              {TENURE_LABELS[t]}
            </div>
          ))}
          {kindsPresent.length > 0 && <div className={css.legendTitle}>Machines</div>}
          {kindsPresent.map((k) => (
            <div key={k} className={css.legendRow}>
              <span className={css.dot} style={{ borderColor: KIND_COLORS[k] }} />
              {KIND_LABELS[k]}
            </div>
          ))}
          {kindsPresent.length > 0 && (
            <>
              <div className={css.legendRow}>
                <span
                  className={css.dot}
                  style={{ borderColor: STALE_RING_COLOR, background: STALE_COLOR }}
                />
                Stale (no fix for {formatDuration(data.config.staleAfterSeconds)}
                {data.config.deereStaleAfterSeconds !== data.config.staleAfterSeconds
                  ? `; Deere ${formatDuration(data.config.deereStaleAfterSeconds)}`
                  : ''}
                )
              </div>
              <div className={css.legendRow}>
                <span className={css.dot} style={{ borderColor: DOWN_COLOR }} />
                Down
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
