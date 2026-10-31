/**
 * The vehicle kind badge (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.4.7): the kind in
 * its map colour, "set by hand" when someone chose it on /admin/vehicles, and the route the data
 * takes (Ford Pro, Stellantis Mobilisights, a gateway). No hooks: it renders on the server
 * (/admin/vehicles) and in client components (the fleet panel row, where the integrator mounts
 * it: `<VehicleKindBadge kind={m.kind} kindSetBy={m.kindSetBy} via={m.via} />`).
 */

import { type KindBadgeInput, kindBadge } from './kind-badge';
import css from './kind-badge.module.css';

export function VehicleKindBadge(props: KindBadgeInput & { compact?: boolean }) {
  const b = kindBadge(props);
  return (
    <span
      className={css.badge}
      title={b.title}
      data-testid="vehicle-kind-badge"
      data-kind={props.kind}
      data-set-by={b.setBy}
    >
      <span className={css.dot} style={{ background: b.color }} aria-hidden="true" />
      {b.label}
      {b.setBy === 'admin' && <span className={css.hand}>set by hand</span>}
      {b.route && !props.compact && <span className={css.route}>{b.route}</span>}
    </span>
  );
}
