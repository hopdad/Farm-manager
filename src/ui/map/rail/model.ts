/**
 * What the layer rail shows (pure; unit-tested): the resolved layers (../layers/types.ts) grouped
 * in rail order (LAYER_GROUPS: fields, soils, elevation and drainage, imagery, tile maps,
 * parcels, live fleet, custom-work customers), each with its toggle state and a status line:
 *
 *  - loading:  the registry hasn't answered yet (a built layer can't be drawn without its row)
 *  - missing:  not built yet: the def's build hint ("Run pnpm gis:soils …"); not toggleable
 *  - mismatch: the registry row's cache policy disagrees with the code: never drawn
 *  - offline:  an online-only layer (kind 'online', offline: false) while the browser is offline
 *              or its tiles are failing (internet down behind a working LAN): still toggleable,
 *              shown as "offline" (plan 1d done-when)
 *  - ready
 * plus a zoom hint when an "on" layer only draws further in (soils from z10), the layer's
 * legend while it is on, and where its data comes from (survey vintage, or the synthetic fixture).
 * A layer drawn more than one way (./modes.ts: the soils colour-by modes) offers its modes while
 * it is on, and its legend is the chosen mode's. A group nobody has built a layer for yet says
 * what will fill it.
 */
import type { LayerLegend } from '../../../domain/map-layers';
import {
  LAYER_GROUP_LABELS,
  LAYER_GROUPS,
  type LayerDef,
  type LayerGroup,
  type ResolvedLayer,
} from '../layers/types';
import { isLayerVisible } from '../layers/visibility';
import type { BasemapFlavor, MapVariant } from '../types';
import { LAYER_MODES, type LayerModeOption, type LayerModes, layerModeOf } from './modes';

export type RailItemStatus = 'ready' | 'loading' | 'missing' | 'mismatch' | 'offline';

export interface RailItem {
  key: string;
  label: string;
  on: boolean;
  /** The default it falls back to after a reset. */
  defaultVisible: boolean;
  toggleable: boolean;
  status: RailItemStatus;
  /** Status line under the label (null when ready). */
  message: string | null;
  /** "Zoom in to see it" when on but the map is out of its zooms. */
  zoomHint: string | null;
  /** Legend while on (a layer with modes: the chosen mode's). */
  legend: LayerLegend | null;
  /** The ways it can be drawn and the chosen one, while it is on (null: one way only). */
  mode: { options: readonly LayerModeOption[]; current: string } | null;
  /** Data source line (survey vintage), or the synthetic-fixture warning. */
  source: string | null;
  synthetic: boolean;
}

export interface RailGroup {
  group: LayerGroup;
  label: string;
  items: RailItem[];
  /** For a group with no layers yet. */
  hint: string | null;
}

/** What fills the groups other builders' slices bring (shown until their layers exist). */
export const GROUP_HINTS: Partial<Record<LayerGroup, string>> = {
  terrain: 'Hillshade, slope and flow paths arrive with the lidar (pnpm gis:dem).',
  imagery: 'Aerial photos: pnpm gis:naip.',
  tile: 'Tile maps: pnpm import:tile <file>, or draw them.',
  parcels: 'Parcels and owners: pnpm gis:parcels <file>.',
};

export interface RailModelInput {
  resolved: readonly ResolvedLayer[];
  overrides: Readonly<Record<string, boolean>>;
  /** GET /api/layers has answered at least once. */
  loaded: boolean;
  /** navigator.onLine. */
  online: boolean;
  /** Layer keys whose tiles are failing right now. */
  failing: ReadonlySet<string>;
  /** Current map zoom (null before the map exists). */
  zoom: number | null;
  /** Chosen modes by layer key (absent: the layer's default). */
  modes?: Readonly<Record<string, string>>;
  /** What the layers are styled for (a mode's legend may depend on it); default dark. */
  flavor?: BasemapFlavor;
  variant?: MapVariant;
  /** Layers with modes (tests); default LAYER_MODES. */
  modeRegistry?: Readonly<Record<string, LayerModes>>;
}

/** Its tiles come over the internet (an online layer, or one that doesn't work offline). */
export function isOnlineOnly(def: Pick<LayerDef, 'kind' | 'offline'>): boolean {
  return def.kind === 'online' || !def.offline;
}

/**
 * Is the internet down behind a working LAN? Yes while an online-only layer's tiles fail (a
 * local layer failing is the app or the PC, not the internet). ./internet.ts carries it to the
 * soil map unit sheet.
 */
export function wanDownOf(
  resolved: readonly { def: Pick<LayerDef, 'key' | 'kind' | 'offline'> }[],
  failing: ReadonlySet<string>,
): boolean {
  return resolved.some((r) => isOnlineOnly(r.def) && failing.has(r.def.key));
}

function itemOf(r: ResolvedLayer, input: RailModelInput): RailItem {
  const { def, row } = r;
  const on = isLayerVisible(input.overrides, def.key, r.defaultVisible);
  const needsRow = def.render === 'maplibre' && def.requiresRow;
  const onlineOnly = isOnlineOnly(def);
  let status: RailItemStatus = 'ready';
  let message: string | null = null;
  if (needsRow && !input.loaded && !row) {
    status = 'loading';
    message = 'Loading…';
  } else if (r.status === 'missing') {
    status = 'missing';
    message = def.render === 'maplibre' && def.buildHint ? def.buildHint : 'Not built yet';
  } else if (r.status === 'mismatch') {
    status = 'mismatch';
    message = `Not shown: the registry marks it ${row?.cachePolicy ?? '?'}, the app expects ${def.cachePolicy}`;
  } else if (onlineOnly && (!input.online || input.failing.has(def.key))) {
    status = 'offline';
    message = 'Offline: needs the internet';
  }
  let zoomHint: string | null = null;
  if (on && status === 'ready' && def.render === 'maplibre' && input.zoom !== null) {
    const minzoom = row?.minzoom ?? def.minzoom;
    if (input.zoom < minzoom - 1e-6) zoomHint = `Zoom in to see it (from zoom ${minzoom})`;
  }
  const synthetic = row?.meta.fixture === true;
  const shown = on && (status === 'ready' || status === 'offline');
  const registry = input.modeRegistry ?? LAYER_MODES;
  const modes = registry[def.key];
  const current = modes ? layerModeOf(input.modes ?? {}, def.key, registry) : null;
  const ctx = { flavor: input.flavor ?? 'dark', variant: input.variant ?? 'wall' } as const;
  return {
    key: def.key,
    label: def.label,
    on,
    defaultVisible: r.defaultVisible,
    toggleable: status === 'ready' || status === 'offline',
    status,
    message,
    zoomHint,
    legend: shown ? (modes && current !== null ? modes.legend(current, ctx) : r.legend) : null,
    mode: shown && modes && current !== null ? { options: modes.options, current } : null,
    source: synthetic ? 'Synthetic test fixture, not survey data' : (row?.sourceVintage ?? null),
    synthetic,
  };
}

export function railModel(input: RailModelInput): RailGroup[] {
  return LAYER_GROUPS.map((group) => {
    const items = input.resolved.filter((r) => r.def.group === group).map((r) => itemOf(r, input));
    return {
      group,
      label: LAYER_GROUP_LABELS[group],
      items,
      hint: items.length === 0 ? (GROUP_HINTS[group] ?? 'Nothing here yet.') : null,
    };
  });
}

/** `layer:<key>` or `layer:<key>:…` → key (map error events name the source). */
export function layerKeyOfSource(sourceId: string | undefined | null): string | null {
  const m = /^layer:([a-z][a-z0-9_]{0,62})(?::|$)/.exec(sourceId ?? '');
  return m?.[1] ?? null;
}
