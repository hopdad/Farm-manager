/**
 * Field panel tab contract (plan 1a/1c "tap a field"; docs/contracts-m1.md §8).
 *
 * The field-panel builder owns the panel (src/ui/fields/**): the wall's side panel with 72 px
 * targets and the phone's bottom sheet. It loads one `FieldDetail` (GET /api/fields/<id>) and
 * renders the registered tabs (./tab-registry.ts) in `order`, passing them the same props.
 * Other builders each write ONE tab in their own file and never touch the panel:
 *
 *   tab           id         order  owner        file
 *   Overview      overview   10     field-panel  src/ui/fields/tabs/overview.tsx
 *   History       history    20     field-data   src/ui/fields/tabs/history.tsx
 *   Soils         soils      30     soils        src/ui/fields/tabs/soils.tsx
 *   Parcels       parcels    40     imagery      src/ui/fields/tabs/parcels.tsx
 *   Weather/spray weather    50     weather      src/ui/weather/FieldWeatherTab.tsx
 *
 * A tab is a client component that renders from `detail` (no fetch needed for the data in
 * FieldDetail) and may fetch more itself. After a save it calls `onChanged(parts)` and the panel
 * refetches; realtime `fields`/`updated` does the same for other screens. Server code
 * re-checks every permission: `role` only hides controls.
 */
import type { ComponentType } from 'react';
import type { FieldDetail, FieldPart } from '../../domain/fields';
import type { Role } from '../../platform/auth/types';

export interface FieldPanelTabProps {
  fieldId: string;
  /** null while the first load is in flight (render a skeleton). */
  detail: FieldDetail | null;
  /** 'wall': 72 px touch targets; 'phone': bottom sheet. */
  variant: 'wall' | 'phone';
  /** The viewer's effective role (UI hints only; the server re-checks). */
  role: Role;
  /** A tab saved something: the panel refetches the detail (and publishes nothing itself). */
  onChanged(parts: FieldPart[]): void;
}

export interface FieldPanelTab {
  /** Unique, lower-case (the panel's URL hash and test ids use it: `field-tab-<id>`). */
  id: string;
  label: string;
  /** Ascending; see the table above for the reserved slots. */
  order: number;
  Component: ComponentType<FieldPanelTabProps>;
  /** Show the tab for this field? Default: always. */
  visible?(detail: FieldDetail): boolean;
  /** Minimum role to see the tab. Default 'viewer'. */
  minRole?: Role;
}

/** Reserved `order` slots (so two builders never pick the same). */
export const TAB_ORDER = {
  overview: 10,
  history: 20,
  soils: 30,
  parcels: 40,
  weather: 50,
} as const;

const TAB_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The tabs in display order. Throws on a malformed or duplicate id (a registry mistake should
 * fail tests, not hide a tab).
 */
export function orderTabs(tabs: readonly FieldPanelTab[]): FieldPanelTab[] {
  const seen = new Set<string>();
  for (const t of tabs) {
    if (!TAB_ID_RE.test(t.id))
      throw new Error(`field panel tab id '${t.id}' is not a lower-case slug`);
    if (seen.has(t.id)) throw new Error(`field panel tab '${t.id}' is registered twice`);
    seen.add(t.id);
  }
  return [...tabs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
