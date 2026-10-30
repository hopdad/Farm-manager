/**
 * The fleet panel's state and grouping (pure; src/ui/fleet/model.test.ts):
 *
 *  - `reducePanel(state, action)` applies the GET /api/machines snapshot, live `fleet`/`tick`
 *    events (positions, activity and status of every machine with a fix) and `fleet`/`machine`
 *    events (one machine marked down or back up, with its reason).
 *  - `groupMachines(machines, now, thresholds)` sorts them into the four groups the wall and
 *    the phone show: moving, idle, down, stale. A down machine is "down" whatever its fix says;
 *    otherwise a machine with no fix, or one older than its source's stale threshold
 *    (FLEET_STALE_SECONDS, or FLEET_STALE_SECONDS_DEERE for Deere's working-only fixes), is
 *    "stale"; otherwise working or on the road is "moving", idle or in line is "idle".
 */
import { CONNECTIONS, connectionEntry } from '../../connectors/vendors';
import {
  type FleetTick,
  isMachineStale,
  type MachineView,
  type PositionSource,
  type StaleThresholds,
} from '../../domain/fleet';
import type { MachineStatusPayload } from '../../platform/realtime/types';
import type { FleetPanelData, PanelMachine } from './contract';

/**
 * `unplaced`: never reported a position (an implement or a drone nobody tracks). Not stale (a
 * stale fix is an alarm: a tracker that stopped), and not on the map, so it isn't counted as
 * stale anywhere: the wall's stale counts and the map's agree.
 */
export const FLEET_GROUPS = ['moving', 'idle', 'down', 'stale', 'unplaced'] as const;
export type FleetGroup = (typeof FLEET_GROUPS)[number];

export const GROUP_LABELS: Record<FleetGroup, string> = {
  moving: 'Moving',
  idle: 'Idle',
  down: 'Down',
  stale: 'Stale',
  unplaced: 'No position yet',
};

/** The position-source badge: short text on the row, the long form as its title. */
export const SOURCE_BADGES: Record<PositionSource, { short: string; long: string }> = {
  eld: { short: 'ELD', long: 'ELD (truck GPS)' },
  deere_working: { short: 'Deere', long: 'Deere: last working position' },
  cab_device: { short: 'Cab', long: 'Cab device GPS' },
  manual: { short: 'Manual', long: 'Entered by hand' },
};

export interface PanelState {
  /** False until the first snapshot arrives. */
  loaded: boolean;
  machines: PanelMachine[];
  canMarkDown: boolean;
  modes: FleetPanelData['modes'] | null;
  config: FleetPanelData['config'] | null;
  /** The last load or save problem, for a small notice (null when fine). */
  error: string | null;
  /** A tick disagreed with what we know (a status we never heard about): refetch. */
  needsRefetch: boolean;
}

export const initialPanelState: PanelState = {
  loaded: false,
  machines: [],
  canMarkDown: false,
  modes: null,
  config: null,
  error: null,
  needsRefetch: false,
};

export type PanelAction =
  | { type: 'snapshot'; data: FleetPanelData }
  | { type: 'tick'; tick: FleetTick }
  | { type: 'machine'; payload: MachineStatusPayload }
  | { type: 'error'; message: string | null };

const byUnit = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sortMachines(list: PanelMachine[]): PanelMachine[] {
  return list.sort((a, b) => byUnit.compare(a.unitNo, b.unitNo) || (a.id < b.id ? -1 : 1));
}

/**
 * Apply one machine of a tick. `odd` asks for a refetch: a status change we never heard about
 * (down without a reason) or a move into a field whose name we don't have.
 */
function applyTickMachine(m: PanelMachine, v: MachineView): { next: PanelMachine; odd: boolean } {
  const sameField = m.position?.fieldId === v.fieldId;
  const next: PanelMachine = {
    ...m,
    position: {
      lng: v.lng,
      lat: v.lat,
      heading: v.heading,
      speedMph: v.speedMph,
      activity: v.activity,
      positionSource: v.positionSource,
      ts: v.ts,
      fieldId: v.fieldId,
      fieldName: sameField ? (m.position?.fieldName ?? null) : null,
      // The tick doesn't carry the vendor: keep the last one the snapshot said (1f.2).
      ...(m.position?.vendor !== undefined ? { vendor: m.position.vendor } : {}),
      ...(v.positionKind ? { positionKind: v.positionKind } : {}),
    },
  };
  const newField = !sameField && v.fieldId !== null;
  if (v.status === m.status) return { next, odd: newField };
  if (v.status === 'active') {
    return {
      next: { ...next, status: 'active', downReason: null, downAt: null, downBy: null },
      odd: newField,
    };
  }
  // Down (or retired) by a change we never heard about: show it, fetch the reason.
  return { next: { ...next, status: v.status }, odd: true };
}

export function reducePanel(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'snapshot':
      return {
        loaded: true,
        machines: sortMachines([...action.data.machines]),
        canMarkDown: action.data.canMarkDown,
        modes: action.data.modes,
        config: action.data.config,
        error: null,
        needsRefetch: false,
      };
    case 'tick': {
      if (!state.loaded) return state;
      const views = new Map(action.tick.machines.map((v) => [v.id, v]));
      let odd = false;
      let unknown = false;
      const machines = state.machines.map((m) => {
        const v = views.get(m.id);
        if (!v) return m;
        views.delete(m.id);
        const r = applyTickMachine(m, v);
        odd ||= r.odd;
        return r.next;
      });
      // A machine the snapshot didn't have (added since): fetch it with its details.
      if (views.size > 0) unknown = true;
      return {
        ...state,
        machines: machines.filter((m) => m.status !== 'retired'),
        needsRefetch: state.needsRefetch || odd || unknown,
      };
    }
    case 'machine': {
      const p = action.payload;
      let found = false;
      const machines = state.machines.map((m) => {
        if (m.id !== p.machineId) return m;
        found = true;
        return {
          ...m,
          status: p.status,
          downReason: p.status === 'down' ? p.downReason : null,
          downAt: p.status === 'down' ? p.downAt : null,
          downBy: p.status === 'down' ? p.by : null,
        };
      });
      return {
        ...state,
        machines: machines.filter((m) => m.status !== 'retired'),
        needsRefetch: state.needsRefetch || (state.loaded && !found),
      };
    }
    case 'error':
      return { ...state, error: action.message };
  }
}

/** A machine as a row: its group and whether its fix is stale right now. */
export interface PanelRow {
  machine: PanelMachine;
  group: FleetGroup;
  stale: boolean;
}

export function groupOf(
  m: PanelMachine,
  now: Date,
  thresholds: StaleThresholds,
): { group: FleetGroup; stale: boolean } {
  const stale =
    m.position !== null &&
    isMachineStale(
      {
        ts: m.position.ts,
        positionSource: m.position.positionSource,
        positionKind: m.position.positionKind,
      },
      now,
      thresholds,
    );
  if (m.status === 'down') return { group: 'down', stale };
  if (m.position === null) return { group: 'unplaced', stale };
  if (stale) return { group: 'stale', stale };
  const a = m.position?.activity;
  return { group: a === 'working' || a === 'transport' ? 'moving' : 'idle', stale };
}

/** Rows by group, each group in unit-number order. */
export function groupMachines(
  machines: readonly PanelMachine[],
  now: Date,
  thresholds: StaleThresholds,
): Record<FleetGroup, PanelRow[]> {
  const out: Record<FleetGroup, PanelRow[]> = {
    moving: [],
    idle: [],
    down: [],
    stale: [],
    unplaced: [],
  };
  for (const machine of machines) {
    const { group, stale } = groupOf(machine, now, thresholds);
    out[group].push({ machine, group, stale });
  }
  return out;
}

/** Thresholds from the snapshot's config (defaults until it loads). */
export function thresholdsOf(config: FleetPanelData['config'] | null): StaleThresholds {
  return {
    staleAfterSeconds: config?.staleAfterSeconds ?? 600,
    deereStaleAfterSeconds: config?.deereStaleAfterSeconds ?? 600,
    ...(config?.lastKnownStaleAfterSeconds
      ? { lastKnownStaleAfterSeconds: config.lastKnownStaleAfterSeconds }
      : {}),
  };
}

/**
 * Connector modes worth flagging on the panel ("replay", "sim"), one per connection in
 * CONNECTIONS order, labelled from the vendor registry: never shown for live or off.
 */
export function modeNotices(modes: FleetPanelData['modes'] | null): string[] {
  if (!modes) return [];
  return CONNECTIONS.filter((c) => modes[c] !== 'live' && modes[c] !== 'off').map(
    (c) => `${connectionEntry(c).label}: ${modes[c]}`,
  );
}
