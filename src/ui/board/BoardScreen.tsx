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
import { TileLineDrawTool, useTileDrawStore } from '../map/draw/TileLineDrawTool';
import type { FleetFrame } from '../map/fleet/model';
import { KIND_COLORS, KIND_LABELS } from '../map/fleet/style';
import { type FleetStatus, useFleet } from '../map/fleet/useFleet';
import { useLayerVisible } from '../map/layers/visibility';
import { LayerRail, type RailMap } from '../map/rail/LayerRail';
import type { MapPageData, MapVariant } from '../map/types';
import { DeerePins, openPinFromTap, PIN_TAP_LAYERS } from '../pins';
import { SprayFieldState, WeatherStrip } from '../weather';
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
  return (
    <>
      <div>
        {ACTIVITY_LABELS[m.activity]} · {Math.round(m.speedMph)} mph {compassPoint(m.heading)}
      </div>
      <div className={css.muted}>
        Last fix {formatAge(m.ts, now)} · {SOURCE_LABELS[m.positionSource]}
      </div>
      {m.stale && <div className={css.staleTag}>Stale: no recent position</div>}
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
    </section>
  );
}

/**
 * The composed screen (docs/contracts-m1.md §12; the integrator owns this layout):
 *
 *   wall   status strip (clock, fleet counts, who is signed in) over the map. Left: the layer
 *          rail (open by default, a button at the left edge when closed). Right, beside the map
 *          controls: the fleet panel, replaced by the field panel while a field is open. Bottom,
 *          between the rail and the controls: the weather strip. A tapped machine's card sits
 *          left of the fleet panel; the tile tool (managers) bottom right.
 *   phone  status strip with the session chip; map controls top right; the Fleet button and the
 *          weather chip top left (each opens a full sheet); the rail's button at the left edge;
 *          the field panel and a tapped machine's card as bottom sheets.
 *
 * One MapLibre map (`onMapReady`) is shared by the rail (applyLayers), the spray colours
 * (SprayFieldState), the field panel's highlight and the tile tool. Field taps open the panel,
 * except while a tile line is being drawn; the rail's "Machines and trucks" toggle hides the
 * deck.gl fleet.
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
  const drawing = useTileDrawStore((s) => s.drawing);
  const selected = status.machines.find((m) => m.id === selectedId) ?? null;
  // A machine picked on the map closes the field panel: its card would sit under the panel
  // (wall), and the phone shows one bottom sheet at a time.
  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setFieldId(null);
  }, []);
  const locate = useCallback((m: { id: string; lng: number; lat: number }) => {
    setSelectedId(m.id);
    setFlyTo({ lng: m.lng, lat: m.lat, nonce: Date.now() });
  }, []);
  const closeField = useCallback(() => setFieldId(null), []);

  return (
    <main
      className={`${css.screen} ${variant === 'phone' ? css.phoneScreen : ''}`}
      data-testid={variant === 'wall' ? 'board' : 'phone-board'}
    >
      <StatusStrip status={status} variant={variant}>
        <SessionChip variant={variant} placement="strip" />
      </StatusStrip>
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
          onFieldTap={drawing ? undefined : setFieldId}
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
        <TileLineDrawTool map={map} variant={variant} config={data.config} onOpen={closeField} />
        <DeerePins map={map} variant={variant} config={data.config} onOpen={closeField} />
        {fieldId && (
          <FieldPanel
            fieldId={fieldId}
            variant={variant}
            config={data.config}
            map={map}
            onClose={closeField}
          />
        )}
      </div>
      {selected && fleetVisible && variant === 'phone' && (
        <PhoneMachineCard m={selected} onClose={() => setSelectedId(null)} />
      )}
    </main>
  );
}
