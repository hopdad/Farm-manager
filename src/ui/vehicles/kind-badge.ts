/**
 * The vehicle kind badge's words (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.4.7):
 * what a machine is (its kind, coloured as on the map), who said so (a vendor tag, by hand on
 * /admin/vehicles, or the default) and how its data reaches the vendor (the `via` route: Ford Pro,
 * Stellantis Mobilisights, an asset or OBD-II gateway). Pure: the badge component
 * (./KindBadge.tsx) and its tests read it. The integrator mounts the badge in the fleet panel row.
 */
import { vendorLabel } from '../../connectors/vendors';
import type { MachineKind } from '../../domain/fleet';
import type { KindSetBy } from '../../domain/vehicles';
import { KIND_COLORS, KIND_LABELS } from '../map/fleet/style';

export interface KindBadgeInput {
  kind: MachineKind;
  /** machines.kind_set_by (absent: as seeded). */
  kindSetBy?: KindSetBy | null;
  /** machines.telematics_via (absent or null: the vendor's own device). */
  via?: string | null;
}

export interface KindBadgeView {
  label: string;
  color: string;
  setBy: KindSetBy;
  /** The route's label ("Ford Pro"), or null. */
  route: string | null;
  /** The whole story, for the tooltip and screen readers. */
  title: string;
}

const SET_BY_TEXT: Record<KindSetBy, string> = {
  default: 'as set up',
  vendor: "from the vendor's tag",
  admin: 'set by hand on /admin/vehicles (vendor tags no longer change it)',
};

export function kindBadge(i: KindBadgeInput): KindBadgeView {
  const setBy = i.kindSetBy ?? 'default';
  const label = KIND_LABELS[i.kind];
  const route = i.via ? vendorLabel(i.via) : null;
  return {
    label,
    color: KIND_COLORS[i.kind],
    setBy,
    route,
    title: `${label}, ${SET_BY_TEXT[setBy]}${route ? ` · data through ${route}` : ''}`,
  };
}
