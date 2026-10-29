'use client';
/**
 * The /board (wall) and /m (phone) screens around the war-room map: a clock/status strip, the
 * map, the selected machine's card and, on phones, a bottom sheet listing the fleet. The map is
 * client-only (next/dynamic, ssr: false); this shell renders on the server.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { SessionChip } from '../../app/login/_components/SessionChip';
import type { FleetFrame } from '../map/fleet/model';
import { KIND_COLORS, KIND_LABELS } from '../map/fleet/style';
import { type FleetStatus, useFleet } from '../map/fleet/useFleet';
import type { MapPageData, MapVariant } from '../map/types';
import css from './board.module.css';
import { ACTIVITY_LABELS, compassPoint, formatAge, formatClock, SOURCE_LABELS } from './format';
import { useKiosk } from './useKiosk';

const WarRoomMap = dynamic(() => import('../map/WarRoomMap'), {
  ssr: false,
  loading: () => <div className={css.loading}>Loading map…</div>,
});

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

function StatusStrip({ status, variant }: { status: FleetStatus; variant: MapVariant }) {
  const now = useNow(1000);
  const clock = now === null ? null : formatClock(new Date(now));
  const { counts, connection } = status;
  return (
    <header className={css.strip} data-testid="status-strip">
      {variant === 'wall' && <span className={css.brand}>Farm Ops · War room</span>}
      <span className={css.clock} data-testid="clock">
        {clock?.time ?? '--:--'}
      </span>
      {variant === 'wall' && <span className={css.date}>{clock?.date ?? ''}</span>}
      <span className={css.spacer} />
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
              : 'Offline'
          : null}
      </span>
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

function FleetSheet(props: {
  machines: FleetFrame[];
  selected: FleetFrame | null;
  onPick(m: FleetFrame): void;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(5000) ?? Date.now();
  return (
    <section className={`${css.sheet} ${open ? css.sheetOpen : ''}`} data-testid="fleet-sheet">
      <button
        type="button"
        className={css.sheetHandle}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={css.grip} />
        Fleet ({props.machines.length})
      </button>
      <div className={css.sheetBody}>
        {props.selected && (
          <div className={css.sheetDetails} data-testid="machine-details">
            <strong>
              {props.selected.unitNo} · {KIND_LABELS[props.selected.kind]}
            </strong>
            <MachineDetails m={props.selected} now={now} />
          </div>
        )}
        {props.machines.length === 0 && <div className={css.empty}>No machines reporting yet.</div>}
        {props.machines.map((m) => (
          <button
            type="button"
            key={m.id}
            className={`${css.row} ${m.id === props.selected?.id ? css.rowSelected : ''}`}
            onClick={() => props.onPick(m)}
            data-testid="fleet-row"
          >
            <span className={css.rowDot} style={{ background: KIND_COLORS[m.kind] }} />
            <strong>{m.unitNo}</strong>
            <span>
              {ACTIVITY_LABELS[m.activity]}
              {m.stale ? <span className={css.staleTag}> · stale</span> : null}
            </span>
            <span className={css.muted}>{formatAge(m.ts, now)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function BoardScreen({ data, variant }: { data: MapPageData; variant: MapVariant }) {
  useKiosk();
  const { model, status } = useFleet({
    appEnv: data.config.appEnv,
    realtime: data.config.realtime,
    staleAfterSeconds: data.config.staleAfterSeconds,
    deereStaleAfterSeconds: data.config.deereStaleAfterSeconds,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ lng: number; lat: number; nonce: number } | null>(null);
  const selected = status.machines.find((m) => m.id === selectedId) ?? null;
  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);
  const pick = useCallback((m: FleetFrame) => {
    setSelectedId(m.id);
    setFlyTo({ lng: m.lng, lat: m.lat, nonce: Date.now() });
  }, []);

  return (
    <main
      className={`${css.screen} ${variant === 'phone' ? css.phoneScreen : ''}`}
      data-testid={variant === 'wall' ? 'board' : 'phone-board'}
    >
      <StatusStrip status={status} variant={variant} />
      <SessionChip variant={variant} />
      <div className={css.mapArea}>
        <WarRoomMap
          data={data}
          variant={variant}
          flavor={variant === 'wall' ? 'dark' : 'light'}
          fleet={model}
          fleetStatus={status}
          selectedId={selectedId}
          onSelect={onSelect}
          showLegend={variant === 'wall'}
          flyTo={flyTo}
        />
        {selected && variant === 'wall' && (
          <MachineCard m={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
      {variant === 'phone' && (
        <FleetSheet machines={status.machines} selected={selected} onPick={pick} />
      )}
    </main>
  );
}
