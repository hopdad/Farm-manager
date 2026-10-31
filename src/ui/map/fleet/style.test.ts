/**
 * Map styling per kind (pure): every machine kind has a colour, a label and an icon the atlas
 * holds; pickups, service trucks and loaders have their own silhouettes; no two kinds share a
 * colour; the last-known, stale and down looks.
 */
import { describe, expect, test } from 'vitest';
import { MACHINE_KINDS } from '../../../domain/fleet';
import {
  hexToRgba,
  ICON_ATLAS,
  ICON_MAPPING,
  iconFor,
  KIND_COLORS,
  KIND_LABELS,
  LAST_KNOWN_ICON_ALPHA,
  markerLook,
  STALE_COLOR,
  STALE_RING_COLOR,
} from './style';

const atlasSvg = decodeURIComponent(ICON_ATLAS.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));

describe('per-kind style', () => {
  test('every kind has a colour, a label and an icon in the atlas', () => {
    for (const kind of MACHINE_KINDS) {
      expect(KIND_COLORS[kind], kind).toMatch(/^#[0-9a-f]{6}$/i);
      expect(KIND_LABELS[kind].length, kind).toBeGreaterThan(0);
      expect(ICON_MAPPING[iconFor(kind)], kind).toBeDefined();
    }
  });

  test('pickups, service trucks and loaders have their own silhouettes; the rest keep the arrow', () => {
    expect(iconFor('pickup')).toBe('pickup');
    expect(iconFor('service_truck')).toBe('service_truck');
    expect(iconFor('loader')).toBe('loader');
    for (const kind of [
      'combine',
      'grain_cart',
      'semi',
      'tractor',
      'sprayer',
      'planter',
      'trailer',
      'drone',
    ] as const) {
      expect(iconFor(kind), kind).toBe('arrow');
    }
  });

  test('no two kinds share a colour (a service truck never reads as a pickup)', () => {
    const colours = MACHINE_KINDS.map((k) => KIND_COLORS[k].toLowerCase());
    expect(new Set(colours).size).toBe(colours.length);
  });

  test('the atlas: one 64 px cell per icon, side by side, each a centred alpha mask', () => {
    expect(ICON_ATLAS.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const entries = Object.values(ICON_MAPPING);
    const width = Number(/width="(\d+)"/.exec(atlasSvg)?.[1]);
    expect(width).toBe(64 * entries.length);
    expect(new Set(entries.map((e) => e.x)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e).toMatchObject({
        y: 0,
        width: 64,
        height: 64,
        anchorX: 32,
        anchorY: 32,
        mask: true,
      });
      expect(e.x + e.width).toBeLessThanOrEqual(width);
      expect(atlasSvg).toContain(`translate(${e.x} 0)`);
    }
    // Inline: nothing in the atlas ever reaches for the network.
    expect(atlasSvg).not.toMatch(/href|url\(/);
  });
});

describe('markerLook', () => {
  const base = { kind: 'pickup' as const, stale: false, status: 'active' as const, unitNo: 'PU1' };

  test('a live fix: the kind colour, opaque; a last-known fix: fainter icon, the same ring', () => {
    const live = markerLook(base);
    expect(live).toEqual({
      icon: hexToRgba(KIND_COLORS.pickup),
      ring: hexToRgba(KIND_COLORS.pickup),
      label: 'PU1',
    });
    const last = markerLook({ ...base, positionKind: 'last_known' });
    expect(last.icon).toEqual(hexToRgba(KIND_COLORS.pickup, LAST_KNOWN_ICON_ALPHA));
    expect(last.ring).toEqual(live.ring);
    expect(LAST_KNOWN_ICON_ALPHA).toBeLessThan(255);
  });

  test('stale wins over everything; down rings red', () => {
    expect(markerLook({ ...base, stale: true, positionKind: 'last_known' })).toEqual({
      icon: hexToRgba(STALE_COLOR),
      ring: hexToRgba(STALE_RING_COLOR),
      label: 'PU1 stale',
    });
    const down = markerLook({ ...base, kind: 'service_truck', status: 'down' });
    expect(down.icon).toEqual(hexToRgba(KIND_COLORS.service_truck));
    expect(down.label).toBe('PU1 down');
  });
});
