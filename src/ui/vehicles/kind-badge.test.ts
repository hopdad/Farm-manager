/**
 * The vehicle kind badge: its words (kind, who set it, the route) and its markup (react-dom/server,
 * no browser): the map colour, "set by hand", the route left out when compact.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { KIND_COLORS } from '../map/fleet/style';
import { VehicleKindBadge } from './KindBadge';
import { kindBadge } from './kind-badge';

describe('kindBadge', () => {
  test('a pickup from its vendor tag, through Ford Pro', () => {
    expect(kindBadge({ kind: 'pickup', kindSetBy: 'vendor', via: 'ford_pro' })).toEqual({
      label: 'Pickup',
      color: KIND_COLORS.pickup,
      setBy: 'vendor',
      route: 'Ford Pro',
      title: "Pickup, from the vendor's tag · data through Ford Pro",
    });
  });

  test('a service truck set by hand; a semi as seeded with no route; an unknown route as is', () => {
    expect(kindBadge({ kind: 'service_truck', kindSetBy: 'admin', via: 'stellantis' }).title).toBe(
      'Service truck, set by hand on /admin/vehicles (vendor tags no longer change it) · data through Stellantis Mobilisights',
    );
    expect(kindBadge({ kind: 'semi' })).toMatchObject({ setBy: 'default', route: null });
    expect(kindBadge({ kind: 'pickup', via: 'acme_cloud' }).route).toBe('acme_cloud');
  });
});

describe('<VehicleKindBadge>', () => {
  const html = (p: Parameters<typeof VehicleKindBadge>[0]) =>
    renderToStaticMarkup(createElement(VehicleKindBadge, p));

  test('kind, colour, "set by hand" and the route', () => {
    const out = html({ kind: 'service_truck', kindSetBy: 'admin', via: 'ford_pro' });
    expect(out).toContain('data-testid="vehicle-kind-badge"');
    expect(out).toContain('data-kind="service_truck"');
    expect(out).toContain('data-set-by="admin"');
    expect(out).toContain(`background:${KIND_COLORS.service_truck}`);
    expect(out).toContain('Service truck');
    expect(out).toContain('set by hand');
    expect(out).toContain('Ford Pro');
  });

  test('compact leaves the route out; a vendor-set kind has no "set by hand"', () => {
    const out = html({ kind: 'pickup', kindSetBy: 'vendor', via: 'ford_pro', compact: true });
    expect(out).not.toContain('Ford Pro</span>');
    expect(out).toContain('title="Pickup, from the vendor&#x27;s tag · data through Ford Pro"');
    expect(out).not.toContain('set by hand');
  });
});
