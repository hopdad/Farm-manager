import type { ClientRect, DroppableContainer } from '@dnd-kit/core';
import { describe, expect, test } from 'vitest';
import {
  chipsFirst,
  type DropData,
  type DropMap,
  fieldsQueryable,
  MAP_DROP_ID,
  machineChipId,
  personChipId,
  resolveMapDrop,
  suspendMapGestures,
  TRAY_ROW_IDS,
  targetAt,
} from './drop';

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

function container(id: string, data: DropData): DroppableContainer {
  return { id, data: { current: data } } as unknown as DroppableContainer;
}

/** A phone-like layout: the map everywhere, the tray row over its bottom, two chips in it. */
function layout() {
  const containers = [
    container(MAP_DROP_ID, { kind: 'map' }),
    container(TRAY_ROW_IDS.machines, { kind: 'tray-row' }),
    container(machineChipId('a'), { kind: 'machine', machineId: 'a', row: TRAY_ROW_IDS.machines }),
    // Scrolled out of its row to the right (hidden).
    container(machineChipId('b'), { kind: 'machine', machineId: 'b', row: TRAY_ROW_IDS.machines }),
    container(personChipId('p'), { kind: 'person', partyId: 'p', row: TRAY_ROW_IDS.people }),
  ];
  const rects = new Map<string | number, ClientRect>([
    [MAP_DROP_ID, rect(0, 52, 412, 787)],
    [TRAY_ROW_IDS.machines, rect(10, 700, 390, 48)],
    [machineChipId('a'), rect(20, 700, 60, 48)],
    [machineChipId('b'), rect(420, 700, 60, 48)],
    // Its row isn't measured (not rendered): never a target.
    [personChipId('p'), rect(20, 760, 60, 48)],
  ]);
  const run = (pointer: { x: number; y: number } | null, collision = rect(0, 0, 10, 10)) =>
    chipsFirst({
      active: { id: 'work:job:1' } as never,
      collisionRect: collision,
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: pointer,
    }).map((c) => c.id);
  return { run, rects };
}

describe('chipsFirst', () => {
  test('a chip beats the map under it', () => {
    expect(layout().run({ x: 40, y: 720 })).toEqual([machineChipId('a')]);
  });

  test('the map elsewhere; a chip scrolled out of its row never catches the drop', () => {
    const { run, rects } = layout();
    expect(run({ x: 200, y: 300 })).toEqual([MAP_DROP_ID]);
    // Make the hidden chip's rect sit over a visible spot outside its row.
    rects.set(machineChipId('b'), rect(150, 300, 60, 48));
    expect(run({ x: 160, y: 310 })).toEqual([MAP_DROP_ID]);
    expect(run({ x: 40, y: 780 })).toEqual([MAP_DROP_ID]);
  });

  test('outside the map and the chips: nothing (the card springs back)', () => {
    expect(layout().run({ x: 200, y: 20 })).toEqual([]);
  });

  test('the keyboard (no pointer) goes by the overlay’s rectangle', () => {
    expect(layout().run(null, rect(30, 705, 20, 20))).toEqual([machineChipId('a')]);
  });
});

function fakeMap(opts: {
  layer?: boolean;
  visibility?: 'visible' | 'none';
  zoom?: number;
  minzoom?: number;
  hits?: { properties?: Record<string, unknown> | null }[];
}): DropMap & { queried: [number, number][] } {
  const canvas = { tag: 'canvas' };
  const container = {
    contains: (el: unknown) => el === canvas,
    getBoundingClientRect: () => ({ left: 0, top: 280 }),
  };
  const queried: [number, number][] = [];
  return {
    queried,
    getContainer: () => container as unknown as HTMLElement,
    getLayer: (id) => (opts.layer === false ? undefined : { id }),
    getLayoutProperty: () => opts.visibility ?? 'visible',
    getSource: () => ({ minzoom: opts.minzoom ?? 8 }),
    getZoom: () => opts.zoom ?? 15,
    queryRenderedFeatures: (p) => {
      queried.push(p);
      return opts.hits ?? [];
    },
    unproject: ([x, y]) => ({ lng: -84 + x / 1000, lat: 42 - y / 1000 }),
    // biome-ignore lint/suspicious/noExplicitAny: a fake element tree for elementFromPoint.
    canvas: canvas as any,
  } as DropMap & { queried: [number, number][] };
}

const docAt = (target: 'canvas' | 'panel' | 'none', map: DropMap & { canvas?: unknown }) => ({
  elementFromPoint: () =>
    target === 'none'
      ? null
      : ({
          closest: (sel: string) =>
            target === 'canvas' && sel === '.maplibregl-canvas-container'
              ? (map as unknown as { canvas: unknown }).canvas
              : null,
        } as unknown as Element),
});

describe('resolveMapDrop', () => {
  test('the field under the drop point, in container coordinates', () => {
    const map = fakeMap({ hits: [{ properties: { id: 'field-1' } }] });
    expect(resolveMapDrop(map, { x: 500, y: 600 }, docAt('canvas', map))).toEqual({
      kind: 'field',
      fieldId: 'field-1',
    });
    expect(map.queried).toEqual([[500, 320]]);
  });

  test('empty map: nothing; a panel or a sheet over the map: nothing', () => {
    const map = fakeMap({ hits: [] });
    expect(resolveMapDrop(map, { x: 1, y: 300 }, docAt('canvas', map))).toEqual({
      kind: 'none',
      reason: 'no_field',
    });
    expect(resolveMapDrop(map, { x: 1, y: 300 }, docAt('panel', map))).toEqual({
      kind: 'none',
      reason: 'off_map',
    });
    expect(resolveMapDrop(map, { x: 1, y: 300 }, docAt('none', map))).toEqual({
      kind: 'none',
      reason: 'off_map',
    });
  });

  test('fields layer hidden or below the tiles’ zoom: the drop point’s lng/lat', () => {
    for (const map of [
      fakeMap({ visibility: 'none' }),
      fakeMap({ zoom: 7.5 }),
      fakeMap({ layer: false }),
      fakeMap({ zoom: 9, minzoom: 10 }),
    ]) {
      expect(fieldsQueryable(map)).toBe(false);
      expect(resolveMapDrop(map, { x: 100, y: 380 }, docAt('canvas', map))).toEqual({
        kind: 'point',
        lngLat: { lng: -83.9, lat: 41.9 },
      });
      expect(map.queried).toEqual([]);
    }
    expect(fieldsQueryable(fakeMap({ zoom: 8 }))).toBe(true);
  });
});

describe('suspendMapGestures', () => {
  const handler = (enabled: boolean) => {
    const h = {
      on: enabled,
      isEnabled: () => h.on,
      enable: () => {
        h.on = true;
      },
      disable: () => {
        h.on = false;
      },
    };
    return h;
  };

  test('off while a drag runs, back exactly as they were (once)', () => {
    const dragPan = handler(true);
    const touchZoomRotate = handler(false);
    const restore = suspendMapGestures({ dragPan, touchZoomRotate });
    expect(dragPan.on).toBe(false);
    expect(touchZoomRotate.on).toBe(false);
    restore();
    expect(dragPan.on).toBe(true);
    // Someone else had turned it off: it stays off.
    expect(touchZoomRotate.on).toBe(false);
    dragPan.disable();
    restore();
    expect(dragPan.on).toBe(false);
  });
});

describe('targetAt: what is under the finger when it lets go', () => {
  /** A fake element: its own test id and attributes, and the selectors `closest` matches. */
  const el = (attrs: Record<string, string>, matches: string[] = []) => ({
    closest: (sel: string) =>
      sel.split(',').some((one) => {
        const s = one.trim();
        return matches.includes(s) || s === `[data-testid="${attrs['data-testid']}"]`;
      })
        ? { getAttribute: (name: string) => attrs[name] ?? null }
        : null,
  });
  const doc = (hit: unknown) => ({ elementFromPoint: () => hit as Element | null });

  test('a machine or a person chip; the map canvas; anything else is nothing', () => {
    expect(
      targetAt(doc(el({ 'data-testid': 'chip-machine', 'data-machine-id': 'm1' })), { x: 1, y: 1 }),
    ).toEqual({ kind: 'machine', machineId: 'm1' });
    expect(
      targetAt(doc(el({ 'data-testid': 'chip-person', 'data-party-id': 'p1' })), { x: 1, y: 1 }),
    ).toEqual({ kind: 'person', partyId: 'p1' });
    expect(
      targetAt(doc(el({ 'data-testid': 'x' }, ['.maplibregl-canvas-container'])), { x: 1, y: 1 }),
    ).toEqual({ kind: 'map' });
    expect(targetAt(doc(el({ 'data-testid': 'weather-strip' })), { x: 1, y: 1 })).toEqual({
      kind: 'none',
    });
    expect(targetAt(doc(null), { x: 1, y: 1 })).toEqual({ kind: 'none' });
  });
});
