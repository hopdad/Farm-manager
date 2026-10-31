'use client';
/**
 * The fleet panel (plan 1a): every machine grouped moving / idle / down / stale, each with its
 * position-source badge (ELD, Deere, cab device, manual) and how long ago it was last seen.
 * Tapping a machine centres the map on it (`onLocate`); drivers and up mark a machine down with
 * a reason, or back up (./StatusSheet.tsx; the server re-checks the role).
 *
 * 1f (fleet-faults, docs/contracts-1f.md §5.3): each row also shows its vendor + mode badge
 * ("Samsara · sim"), its engine hours, odometer and fuel (DEF when known; "not reported" for what
 * its route doesn't report), its active fault codes as a badge (worst first; every code in the
 * title), "faults not reported" when its route reports none, and, for a critical code on a
 * machine that isn't down, "Critical fault: mark down?" to drivers and up: it opens the status
 * sheet with the reason filled in (never automatic; viewers and the wall see the badge only).
 * A Deere-only machine that stopped working reads "Last working position, N min ago".
 *
 *  - wall: a column docked on the left of the map, 72 px touch targets, collapsible.
 *  - phone: a "Fleet" button over the map opening a full-height sheet.
 *
 * Self-contained: it loads GET /api/machines and follows the realtime `fleet` topic itself
 * (./feed.ts), so the board mounts it with one element (docs/contracts-m1.md §12).
 */
import { useCallback, useState } from 'react';
import { KIND_COLORS } from '../map/fleet/style';
import { VehicleKindBadge } from '../vehicles/KindBadge';
import type { FleetPanelData, MachineStatusResult, PanelMachine } from './contract';
import css from './fleet-panel.module.css';
import { faultBadgeText, faultListText, rowAge, rowDetail, rowHeadline, rowStats } from './format';
import {
  criticalFault,
  FLEET_GROUPS,
  type FleetGroup,
  GROUP_LABELS,
  groupMachines,
  markDownReason,
  modeNotices,
  offersMarkDown,
  type PanelRow,
  SOURCE_BADGES,
  thresholdsOf,
  vendorBadge,
  worstFault,
} from './model';
import { StatusSheet } from './StatusSheet';
import { useFleetPanel, useNow } from './useFleetPanel';

/** What the board needs to centre the map on a machine. */
export interface FleetLocateTarget {
  id: string;
  lng: number;
  lat: number;
}

export interface FleetPanelProps {
  variant: 'wall' | 'phone';
  /** Centre the map on this machine (the board flies there and selects it). */
  onLocate?(target: FleetLocateTarget): void;
}

function Row(props: {
  row: PanelRow;
  now: number;
  canMarkDown: boolean;
  modes: FleetPanelData['modes'] | null;
  onLocate(m: PanelMachine): void;
  onStatus(m: PanelMachine, reason?: string): void;
}) {
  const { row, now } = props;
  const m = row.machine;
  const badge = m.position ? SOURCE_BADGES[m.position.positionSource] : null;
  const vendor = vendorBadge(m, props.modes);
  const detail = rowDetail(row);
  const headline = rowHeadline(row, now);
  const worst = worstFault(m);
  const faultText = worst ? faultBadgeText(m.faults ?? []) : null;
  const critical = offersMarkDown(m, props.canMarkDown) ? criticalFault(m) : null;
  return (
    <li
      className={css.row}
      data-testid="fleet-panel-row"
      data-machine-id={m.id}
      data-unit={m.unitNo}
      data-group={row.group}
      data-fault={worst?.severity ?? 'none'}
      data-last-working={row.lastWorking ? 'true' : undefined}
    >
      <button
        type="button"
        className={css.rowMain}
        disabled={!m.position}
        onClick={() => props.onLocate(m)}
        aria-label={`${m.unitNo}: ${headline}${faultText ? `. ${faultText}` : ''}${m.position ? '. Show on the map' : ''}`}
      >
        <span className={css.dot} style={{ background: KIND_COLORS[m.kind] }} />
        <span className={css.unit}>{m.unitNo}</span>
        <span className={css.texts}>
          <span className={css.headline}>{headline}</span>
          {detail && <span className={css.detail}>{detail}</span>}
          <span className={css.stats} data-testid="fleet-stats">
            {rowStats(m)}
          </span>
          <span className={css.meta}>
            <VehicleKindBadge kind={m.kind} kindSetBy={m.kindSetBy} via={m.via} compact />
            {badge && (
              <span
                className={css.badge}
                data-source={m.position?.positionSource}
                title={badge.long}
                data-testid="fleet-source-badge"
              >
                {badge.short}
              </span>
            )}
            {vendor && (
              <span
                className={css.vendorBadge}
                data-vendor={vendor.vendor}
                data-mode={vendor.mode ?? undefined}
                title={`Position from ${vendor.text}${m.position?.positionKind === 'last_known' ? ' (last known)' : ''}`}
                data-testid="fleet-vendor-badge"
              >
                {vendor.text}
              </span>
            )}
            <span className={row.stale ? css.ageStale : css.age} data-testid="fleet-age">
              {rowAge(row, now)}
            </span>
          </span>
          {faultText ? (
            <span
              className={css.faultBadge}
              data-severity={worst?.severity}
              title={faultListText(m.faults ?? [], now)}
              data-testid="fleet-fault-badge"
            >
              {faultText}
            </span>
          ) : m.faultsNotReported ? (
            <span className={css.faultsUnknown} data-testid="fleet-faults-not-reported">
              faults not reported
            </span>
          ) : null}
        </span>
      </button>
      {props.canMarkDown && m.status !== 'retired' && (
        <button
          type="button"
          className={m.status === 'down' ? css.upButton : css.downButton}
          onClick={() => props.onStatus(m)}
          data-testid={m.status === 'down' ? 'fleet-mark-up' : 'fleet-mark-down'}
          aria-label={m.status === 'down' ? `Mark ${m.unitNo} back up` : `Mark ${m.unitNo} down`}
        >
          {m.status === 'down' ? 'Back up' : 'Down'}
        </button>
      )}
      {critical && (
        <button
          type="button"
          className={css.criticalPrompt}
          onClick={() => props.onStatus(m, markDownReason(critical))}
          data-testid="fleet-critical-prompt"
          aria-label={`${m.unitNo}: critical fault ${critical.code}. Mark it down?`}
        >
          Critical fault: mark down?
        </button>
      )}
    </li>
  );
}

function Group(props: {
  group: FleetGroup;
  rows: PanelRow[];
  now: number;
  canMarkDown: boolean;
  modes: FleetPanelData['modes'] | null;
  onLocate(m: PanelMachine): void;
  onStatus(m: PanelMachine, reason?: string): void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section
      className={css.group}
      data-group={props.group}
      data-testid={`fleet-group-${props.group}`}
      aria-label={GROUP_LABELS[props.group]}
    >
      <h3 className={css.groupTitle}>
        {GROUP_LABELS[props.group]} <span className={css.count}>{props.rows.length}</span>
      </h3>
      <ul className={css.rows}>
        {props.rows.map((row) => (
          <Row
            key={row.machine.id}
            row={row}
            now={props.now}
            canMarkDown={props.canMarkDown}
            modes={props.modes}
            onLocate={props.onLocate}
            onStatus={props.onStatus}
          />
        ))}
      </ul>
    </section>
  );
}

export function FleetPanel({ variant, onLocate }: FleetPanelProps) {
  const { state, apply } = useFleetPanel();
  const now = useNow(5_000);
  const [open, setOpen] = useState(variant === 'wall');
  const [editing, setEditing] = useState<{ machine: PanelMachine; reason?: string } | null>(null);
  const groups = groupMachines(state.machines, new Date(now), thresholdsOf(state.config));
  const notices = modeNotices(state.modes, state.machines);
  const edit = useCallback(
    (machine: PanelMachine, reason?: string) =>
      setEditing(reason === undefined ? { machine } : { machine, reason }),
    [],
  );

  const locate = useCallback(
    (m: PanelMachine) => {
      if (!m.position) return;
      onLocate?.({ id: m.id, lng: m.position.lng, lat: m.position.lat });
      if (variant === 'phone') setOpen(false);
    },
    [onLocate, variant],
  );
  const done = useCallback(
    (r: MachineStatusResult) => {
      apply({ type: 'machine', payload: r });
      setEditing(null);
    },
    [apply],
  );
  const cancel = useCallback(() => setEditing(null), []);

  // Counted like the status strip (machines on the map); those that never reported apart.
  const onMap = state.machines.length - groups.unplaced.length;
  const summary = [
    `${onMap} on the map`,
    `${groups.down.length} down`,
    `${groups.stale.length} stale`,
    ...(groups.unplaced.length ? [`${groups.unplaced.length} no position`] : []),
  ].join(' · ');
  const body = (
    <>
      <header className={css.header}>
        <h2 className={css.title}>Fleet</h2>
        <span className={css.summary} data-testid="fleet-panel-summary">
          {summary}
        </span>
        <button
          type="button"
          className={css.close}
          aria-label={variant === 'wall' ? 'Hide the fleet panel' : 'Close the fleet'}
          onClick={() => setOpen(false)}
          data-testid="fleet-panel-close"
        >
          ×
        </button>
      </header>
      {notices.length > 0 && (
        <div className={css.modes} data-testid="fleet-mode-badge" title="Where positions come from">
          {notices.join(' · ')}
        </div>
      )}
      {state.error && (
        <div className={css.notice} role="status">
          {state.error}
        </div>
      )}
      <div className={css.scroll}>
        {!state.loaded && !state.error && <div className={css.empty}>Loading the fleet…</div>}
        {state.loaded && state.machines.length === 0 && (
          <div className={css.empty}>No machines yet.</div>
        )}
        {FLEET_GROUPS.map((g) => (
          <Group
            key={g}
            group={g}
            rows={groups[g]}
            now={now}
            canMarkDown={state.canMarkDown}
            modes={state.modes}
            onLocate={locate}
            onStatus={edit}
          />
        ))}
      </div>
    </>
  );

  return (
    <>
      {open ? (
        <aside
          className={variant === 'wall' ? css.wallPanel : css.phonePanel}
          data-testid="fleet-panel"
          data-variant={variant}
          data-dock={variant === 'wall' ? 'right' : undefined}
          aria-label="Fleet"
        >
          {body}
        </aside>
      ) : (
        <button
          type="button"
          className={variant === 'wall' ? css.wallToggle : css.phoneToggle}
          onClick={() => setOpen(true)}
          data-testid="fleet-panel-toggle"
          aria-label={`Show the fleet (${summary})`}
        >
          Fleet
          {groups.down.length > 0 && (
            <span className={css.toggleDown}>{groups.down.length} down</span>
          )}
        </button>
      )}
      {editing && (
        <StatusSheet
          key={`${editing.machine.id}:${editing.reason ?? ''}`}
          machine={state.machines.find((m) => m.id === editing.machine.id) ?? editing.machine}
          variant={variant}
          {...(editing.reason !== undefined ? { initialReason: editing.reason } : {})}
          onDone={done}
          onCancel={cancel}
        />
      )}
    </>
  );
}

export default FleetPanel;
