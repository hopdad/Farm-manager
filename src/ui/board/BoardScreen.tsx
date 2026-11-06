'use client';
/**
 * The /board (wall) and /m (phone) screens around the war-room map: a clock/status strip, the
 * map and the M1 panels around it (layout: BoardScreen below). The map is client-only
 * (next/dynamic, ssr: false); this shell renders on the server.
 */
import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { SessionChip } from '../../app/login/_components/SessionChip';
import { FieldPanel } from '../fields/FieldPanel';
import { FleetPanel } from '../fleet/FleetPanel';
import { lastKnownText, lastWorkingText } from '../fleet/format';
import { MachineFaultTag } from '../fleet/MachineFaultTag';
import { faultCounts, feedNotices } from '../fleet/model';
import { useFleetPanel } from '../fleet/useFleetPanel';
import { TileLineDrawTool, useTileDrawStore } from '../map/draw/TileLineDrawTool';
import type { FleetFrame } from '../map/fleet/model';
import { KIND_COLORS, KIND_LABELS } from '../map/fleet/style';
import { type FleetStatus, useFleet } from '../map/fleet/useFleet';
import { useLayerVisible } from '../map/layers/visibility';
import { LayerRail, type RailMap } from '../map/rail/LayerRail';
import type { MapPageData, MapVariant } from '../map/types';
import { DeerePins, openPinFromTap, PIN_TAP_LAYERS } from '../pins';
import { MapUnitSheet, mapUnitAt, useMapUnitSheet } from '../soils';
import { UsageHeartbeat } from '../usage/UsageHeartbeat';
import { SprayFieldState, WeatherStrip } from '../weather';
import { closeWorkBoardOverlays } from '../work/board/store';
import { WorkBoard } from '../work/board/WorkBoard';
import { WorkBoardProvider } from '../work/board/WorkBoardProvider';
import css from './board.module.css';
import { ACTIVITY_LABELS, compassPoint, formatAge, formatClock, SOURCE_LABELS } from './format';
import { useKiosk } from './useKiosk';

const WarRoomMap = dynamic(() => import('../map/WarRoomMap'), {
  ssr: false,
  loading: () => <div className={css.loading}>Loading map…</div>,
});

/** The wall is laid out for 1920 x 1080 CSS px (docs/kiosk.md): outside this, say so. */
export const WALL_CSS_WIDTH = { min: 1600, max: 2600 } as const;

/** The window's CSS width, kept current (null before mount). */
function useViewportWidth(): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setW(window.innerWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return w;
}

/** Re-render every `ms` (clock, "2 min ago"). */
function useNow(ms: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function StatusStrip({
  status,
  variant,
  children,
}: {
  status: FleetStatus;
  variant: MapVariant;
  children?: ReactNode;
}) {
  const now = useNow(1000);
  const clock = now === null ? null : formatClock(new Date(now));
  const { counts, connection } = status;
  // 1f review: a failing positions feed and the machines with critical codes, on the strip too
  // (the panel's shared feed: no fetch or subscription of its own).
  const { state: panel } = useFleetPanel();
  const feedsDown = feedNotices(status.feeds ?? panel.feeds, panel.modes);
  const faults = faultCounts(panel.machines);
  const width = useViewportWidth();
  const badScale =
    variant === 'wall' &&
    width !== null &&
    (width < WALL_CSS_WIDTH.min || width > WALL_CSS_WIDTH.max);
  return (
    <header className={css.strip} data-testid="status-strip">
      {variant === 'wall' && <span className={css.brand}>Farm Ops · War room</span>}
      <span className={css.clock} data-testid="clock">
        {clock?.time ?? '--:--'}
      </span>
      {variant === 'wall' && <span className={css.date}>{clock?.date ?? ''}</span>}
      <span className={css.spacer} />
      {badScale && (
        <span
          className={`${css.pill} ${css.pillWarn}`}
          data-testid="display-scaling"
          title={`This screen is ${width} CSS px wide; the board is laid out for 1920 (Chrome --force-device-scale-factor)`}
        >
          Display scaling: see docs/kiosk.md
        </span>
      )}
      <span className={css.pill} data-testid="fleet-summary">
        {counts.total} machine{counts.total === 1 ? '' : 's'}
      </span>
      {counts.stale > 0 && (
        <span className={`${css.pill} ${css.pillWarn}`} data-testid="fleet-stale-count">
          {counts.stale} stale
        </span>
      )}
      {counts.down > 0 && <span className={`${css.pill} ${css.pillBad}`}>{counts.down} down</span>}
      {faults.critical > 0 && (
        <span className={`${css.pill} ${css.pillBad}`} data-testid="fleet-critical-count">
          {faults.critical} critical fault{faults.critical === 1 ? '' : 's'}
        </span>
      )}
      {feedsDown.map((n) => (
        <span
          key={n.connection}
          className={`${css.pill} ${css.pillWarn}`}
          title={n.text}
          data-testid="fleet-feed-down"
          data-connection={n.connection}
        >
          {variant === 'wall' ? n.text : n.short}
        </span>
      ))}
      <span className={css.pill} title={status.error ?? undefined} data-testid="fleet-connection">
        <span
          className={`${css.led} ${connection === 'live' ? css.ledLive : connection === 'unavailable' ? css.ledBad : ''}`}
        />
        {variant === 'wall'
          ? connection === 'live'
            ? 'Live'
            : connection === 'loading'
              ? 'Connecting'
              : status.offlineSince !== null
                ? `Offline since ${formatClock(new Date(status.offlineSince)).time}`
                : 'Offline'
          : null}
      </span>
      {children}
    </header>
  );
}

function MachineDetails({ m, now }: { m: FleetFrame; now: number }) {
  // The vendor of the fix comes with the panel's data (the shared feed; the tick doesn't carry it).
  const { state: panel } = useFleetPanel();
  const vendor = panel.machines.find((x) => x.id === m.id)?.position?.vendor ?? null;
  return (
    <>
      {m.positionKind === 'last_known' ? (
        // A vendor snapshot (1f review): no invented speed or heading, and say what it is.
        <>
          <div data-testid="machine-last-known">
            {lastKnownText(vendor)}, {formatAge(m.ts, now)}
          </div>
          <div className={css.muted}>A periodic snapshot, not a live tracker</div>
        </>
      ) : (
        <>
          <div>
            {ACTIVITY_LABELS[m.activity]} · {Math.round(m.speedMph)} mph {compassPoint(m.heading)}
          </div>
          <div className={css.muted}>
            Last fix {formatAge(m.ts, now)} · {SOURCE_LABELS[m.positionSource]}
          </div>
        </>
      )}
      {m.stale && <div className={css.staleTag}>Stale: no recent position</div>}
      {m.lastWorking && (
        <div className={css.muted} data-testid="machine-last-working">
          {lastWorkingText(m.ts, now)}
        </div>
      )}
      {m.status === 'down' && <div className={css.downTag}>Down for repair</div>}
    </>
  );
}

function MachineCard({ m, onClose }: { m: FleetFrame; onClose(): void }) {
  const now = useNow(5000) ?? Date.now();
  return (
    <section className={css.card} data-testid="machine-card" aria-label={`Machine ${m.unitNo}`}>
      <div className={css.cardTitle}>
        <span className={css.rowDot} style={{ background: KIND_COLORS[m.kind] }} />
        {m.unitNo}
        <span className={css.muted}>{KIND_LABELS[m.kind]}</span>
        <button type="button" className={css.cardClose} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <MachineDetails m={m} now={now} />
      <MachineFaultTag machineId={m.id} />
    </section>
  );
}

/**
 * Phones: the tapped machine's details as a small card above the map's bottom edge (the fleet
 * list itself is the fleet panel's sheet, src/ui/fleet/FleetPanel.tsx).
 */
function PhoneMachineCard({ m, onClose }: { m: FleetFrame; onClose(): void }) {
  const now = useNow(5000) ?? Date.now();
  return (
    <section
      className={css.phoneCard}
      data-testid="machine-details"
      aria-label={`Machine ${m.unitNo}`}
    >
      <div className={css.cardTitle}>
        <span className={css.rowDot} style={{ background: KIND_COLORS[m.kind] }} />
        {m.unitNo}
        <span className={css.muted}>{KIND_LABELS[m.kind]}</span>
        <button type="button" className={css.cardClose} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <MachineDetails m={m} now={now} />
      <MachineFaultTag machineId={m.id} />
    </section>
  );
}

/**
 * The composed screen (docs/contracts-m1.md §12; the integrator owns this layout):
 *
 *   wall   status strip (clock, fleet counts, who is signed in), then the jobs band (2a: lanes
 *          of job cards and the chips tray, a row of its own, so the map area shrinks and no
 *          panel is covered), then the map. Left: the layer rail (open by default, a button at
 *          the left edge when closed). Right, beside the map controls: the fleet panel, replaced
 *          by the field panel while a field is open. Bottom, between the rail and the controls:
 *          the weather strip. A tapped machine's card sits left of the fleet panel; the tile tool
 *          (managers) bottom right.
 *   phone  status strip with the session chip; map controls top right; the Fleet button, the
 *          weather chip and the Jobs pill top left (each opens a sheet); the rail's button at the
 *          left edge; the field panel and a tapped machine's card as bottom sheets.
 *
 * 2a (docs/contracts-2a.md §7.2): the jobs band and the map area sit inside the job board's
 * drag context (WorkBoardProvider), so cards and the drop targets (chips, the map) share it.
 * One sheet at a time: opening a field, a machine or a pin closes the job board's sheet or
 * popover (closeWorkBoardOverlays), and the job board's `onOpen` closes the others.
 *
 * One MapLibre map (`onMapReady`) is shared by the rail (applyLayers), the spray colours
 * (SprayFieldState), the field panel's highlight and the tile tool. Field taps open the panel,
 * except while a tile line is being drawn; the rail's "Machines and trucks" toggle hides the
 * deck.gl fleet. With soils on, a tap on empty map opens the soil map unit sheet in the field
 * panel's place (a field tap still opens the field panel), except while the tile tool is open.
 */
export function BoardScreen({ data, variant }: { data: MapPageData; variant: MapVariant }) {
  useKiosk();
  const { model, status } = useFleet({
    appEnv: data.config.appEnv,
    realtime: data.config.realtime,
    staleAfterSeconds: data.config.staleAfterSeconds,
    deereStaleAfterSeconds: data.config.deereStaleAfterSeconds,
    lastKnownStaleAfterSeconds: data.config.lastKnownStaleAfterSeconds,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fieldId, setFieldId] = useState<string | null>(null);
  const [map, setMap] = useState<RailMap | null>(null);
  // The rail carries the legends under its toggles; the map's own legend shows while it is closed.
  const [railOpen, setRailOpen] = useState(variant === 'wall');
  const [flyTo, setFlyTo] = useState<{ lng: number; lat: number; nonce: number } | null>(null);
  const fleetVisible = useLayerVisible('fleet', true);
  const soilsVisible = useLayerVisible('soils', false);
  const drawing = useTileDrawStore((s) => s.drawing);
  // Taps belong to the open tile tool (selecting a line, a point of the sketch): no soil sheet.
  // While it draws, taps only draw: no pin popup and no field panel either.
  const tileToolOpen = useTileDrawStore((s) => s.open);
  const selected = status.machines.find((m) => m.id === selectedId) ?? null;
  const closeMapUnit = useMapUnitSheet((s) => s.close);
  // A machine picked on the map closes the field panel and the map unit sheet: its card would
  // sit under the panel (wall), and the phone shows one bottom sheet at a time.
  const onSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) {
        setFieldId(null);
        closeMapUnit();
        closeWorkBoardOverlays();
      }
    },
    [closeMapUnit],
  );
  const onFieldTap = useCallback(
    (id: string | null) => {
      setFieldId(id);
      if (id) {
        closeMapUnit();
        closeWorkBoardOverlays();
      }
    },
    [closeMapUnit],
  );
  // Soils on: a tap outside any field opens the map unit under it (else closes the sheet).
  const onEmptyTap = useCallback(
    (lngLat: { lng: number; lat: number }) => {
      const unit = soilsVisible && map ? mapUnitAt(map, lngLat) : null;
      if (unit) useMapUnitSheet.getState().show(unit);
      else closeMapUnit();
    },
    [soilsVisible, map, closeMapUnit],
  );
  useEffect(() => {
    if (!soilsVisible) closeMapUnit();
  }, [soilsVisible, closeMapUnit]);
  const locate = useCallback((m: { id: string; lng: number; lat: number }) => {
    setSelectedId(m.id);
    setFlyTo({ lng: m.lng, lat: m.lat, nonce: Date.now() });
  }, []);
  const closeField = useCallback(() => setFieldId(null), []);
  const closePanels = useCallback(() => {
    setFieldId(null);
    closeMapUnit();
    closeWorkBoardOverlays();
  }, [closeMapUnit]);
  // The job board opened its sheet (phone) or a job popover (wall): the others close.
  const onWorkOpen = useCallback(() => {
    setFieldId(null);
    closeMapUnit();
    if (variant === 'phone') setSelectedId(null);
  }, [closeMapUnit, variant]);

  return (
    <main
      className={`${css.screen} ${variant === 'phone' ? css.phoneScreen : ''}`}
      data-testid={variant === 'wall' ? 'board' : 'phone-board'}
    >
      <StatusStrip status={status} variant={variant}>
        <SessionChip variant={variant} placement="strip" />
      </StatusStrip>
      <WorkBoardProvider variant={variant} map={map}>
        {variant === 'wall' && (
          <WorkBoard variant="wall" map={map} config={data.config} onOpen={onWorkOpen} />
        )}
        <div className={`${css.mapArea} ${variant === 'phone' ? css.phoneMapArea : ''}`}>
          <WarRoomMap
            data={data}
            variant={variant}
            flavor={variant === 'wall' ? 'dark' : 'light'}
            fleet={model}
            fleetStatus={status}
            selectedId={selectedId}
            onSelect={onSelect}
            showLegend={variant === 'wall' && !railOpen}
            flyTo={flyTo}
            fleetVisible={fleetVisible}
            onFieldTap={drawing ? undefined : onFieldTap}
            onEmptyTap={drawing || tileToolOpen ? undefined : onEmptyTap}
            onMapReady={setMap}
            tapLayers={PIN_TAP_LAYERS}
            onFeatureTap={drawing ? undefined : openPinFromTap}
          />
          <SprayFieldState map={map} />
          <LayerRail map={map} variant={variant} config={data.config} onOpenChange={setRailOpen} />
          <FleetPanel variant={variant} onLocate={locate} />
          <WeatherStrip variant={variant} />
          {selected && fleetVisible && variant === 'wall' && (
            <MachineCard m={selected} onClose={() => setSelectedId(null)} />
          )}
          <TileLineDrawTool map={map} variant={variant} config={data.config} onOpen={closePanels} />
          <DeerePins map={map} variant={variant} config={data.config} onOpen={closePanels} />
          {fieldId && (
            <FieldPanel
              fieldId={fieldId}
              variant={variant}
              config={data.config}
              map={map}
              onClose={closeField}
            />
          )}
          <MapUnitSheet variant={variant} map={map} />
          {variant === 'phone' && (
            <WorkBoard variant="phone" map={map} config={data.config} onOpen={onWorkOpen} />
          )}
        </div>
      </WorkBoardProvider>
      {selected && fleetVisible && variant === 'phone' && (
        <PhoneMachineCard m={selected} onClose={() => setSelectedId(null)} />
      )}
      <UsageHeartbeat route={variant === 'wall' ? '/board' : '/m'} />
    </main>
  );
}
