/**
 * Where a dragged job card lands (decision 2a-4, docs/contracts-2a.md §4.5 and §7.1). Pure
 * helpers over minimal map and document interfaces (./drop.test.ts uses fakes):
 *
 *  - the droppable ids and their data (the map drop zone, machine and person chips, the tray
 *    rows that clip the chips scrolled out of view);
 *  - `chipsFirst`: dnd-kit collision detection, `pointerWithin` with the CHIPS before the map
 *    (the phone's chips tray sits over the map), a chip counting only while the pointer is
 *    inside its tray row (a chip scrolled out of its row is hidden, not a target);
 *  - `resolveMapDrop`: the field under the drop point with `queryRenderedFeatures` on
 *    `fields-fill` (container coordinates), only when the point is really on the map canvas
 *    (`elementFromPoint(…).closest('.maplibregl-canvas-container')`: a drop on a panel or a sheet
 *    is "anywhere else"); with the fields layer hidden or the map below the field tiles' zoom the
 *    drop point's lng/lat instead (the server picks the field whose current boundary contains it);
 *  - `suspendMapGestures`: the map's drag-pan and touch zoom/rotate off while a drag runs.
 */
import {
  type ClientRect,
  type Collision,
  type CollisionDetection,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { FIELD_LAYER_IDS, FIELDS_SOURCE } from '../../map/style';

export const MAP_DROP_ID = 'work:map';
export const TRAY_ROW_IDS = { machines: 'work:tray:machines', people: 'work:tray:people' } as const;
export type TrayRowId = (typeof TRAY_ROW_IDS)[keyof typeof TRAY_ROW_IDS];

export const machineChipId = (machineId: string) => `work:machine:${machineId}`;
export const personChipId = (partyId: string) => `work:person:${partyId}`;
export const jobCardId = (jobId: string) => `work:job:${jobId}`;

/** What a droppable carries in its dnd-kit `data`. */
export type DropData =
  | { kind: 'map' }
  | { kind: 'machine'; machineId: string; row: TrayRowId }
  | { kind: 'person'; partyId: string; row: TrayRowId }
  | { kind: 'tray-row' };

/** What a draggable card carries. */
export interface DragData {
  kind: 'job';
  jobId: string;
}

/** Below this zoom the fields source has no tiles (src/app/api/tiles/layers.ts: z8-z16). */
export const FIELD_TILES_MIN_ZOOM = 8;

type DroppableLike = { id: UniqueIdentifier; data: { current?: unknown } };

function dataOf(c: Collision, containers: readonly DroppableLike[]): DropData | null {
  const fromCollision = c.data?.droppableContainer as DroppableLike | undefined;
  const container = fromCollision ?? containers.find((d) => d.id === c.id);
  return (container?.data.current as DropData | undefined) ?? null;
}

function contains(rect: ClientRect | undefined, p: { x: number; y: number }): boolean {
  return !!rect && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
}

/**
 * dnd-kit collision detection: chips first, then the map drop zone, nothing else (tray rows are
 * only there to clip). With the keyboard (no pointer) the overlay's rectangle decides.
 */
export const chipsFirst: CollisionDetection = (args) => {
  const hits = args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
  const containers = args.droppableContainers as unknown as DroppableLike[];
  const point = args.pointerCoordinates ?? {
    x: args.collisionRect.left + args.collisionRect.width / 2,
    y: args.collisionRect.top + args.collisionRect.height / 2,
  };
  const chips = hits.filter((c) => {
    const d = dataOf(c, containers);
    if (!d || (d.kind !== 'machine' && d.kind !== 'person')) return false;
    return contains(args.droppableRects.get(d.row), point);
  });
  if (chips.length > 0) return chips;
  return hits.filter((c) => dataOf(c, containers)?.kind === 'map');
};

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

/** The part of maplibre-gl's Map the drop needs. */
export interface DropMap {
  getContainer(): HTMLElement;
  getLayer(id: string): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  getSource(id: string): unknown;
  getZoom(): number;
  queryRenderedFeatures(
    point: [number, number],
    options: { layers: string[] },
  ): { properties?: Record<string, unknown> | null }[];
  unproject(point: [number, number]): { lng: number; lat: number };
}

export interface PointDoc {
  elementFromPoint(x: number, y: number): Element | null;
}

export type MapDrop =
  | { kind: 'field'; fieldId: string }
  | { kind: 'point'; lngLat: { lng: number; lat: number } }
  | { kind: 'none'; reason: 'off_map' | 'no_field' };

/** Can `fields-fill` answer queryRenderedFeatures right now (shown, and tiles at this zoom)? */
export function fieldsQueryable(map: DropMap): boolean {
  if (!map.getLayer(FIELD_LAYER_IDS.fill)) return false;
  if (map.getLayoutProperty(FIELD_LAYER_IDS.fill, 'visibility') === 'none') return false;
  const source = map.getSource(FIELDS_SOURCE) as { minzoom?: number } | undefined;
  const minzoom = typeof source?.minzoom === 'number' ? source.minzoom : FIELD_TILES_MIN_ZOOM;
  return map.getZoom() >= Math.max(minzoom, FIELD_TILES_MIN_ZOOM);
}

/** The drop point in the map container's coordinates, when it is on this map's canvas. */
export function mapPointAt(
  map: DropMap,
  client: { x: number; y: number },
  doc: PointDoc,
): [number, number] | null {
  const container = map.getContainer();
  const hit = doc.elementFromPoint(client.x, client.y);
  const canvas = hit?.closest('.maplibregl-canvas-container') ?? null;
  if (!canvas || !container.contains(canvas)) return null;
  const rect = container.getBoundingClientRect();
  return [client.x - rect.left, client.y - rect.top];
}

/** The field id under a container point (null: none, or the layer can't answer). */
export function fieldAt(map: DropMap, point: [number, number]): string | null {
  if (!fieldsQueryable(map)) return null;
  let hits: { properties?: Record<string, unknown> | null }[];
  try {
    hits = map.queryRenderedFeatures(point, { layers: [FIELD_LAYER_IDS.fill] });
  } catch {
    return null;
  }
  const id = hits[0]?.properties?.id;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/** Where a card dropped at `client` (viewport px) on the map lands (contracts-2a §4.5). */
export function resolveMapDrop(
  map: DropMap,
  client: { x: number; y: number },
  doc: PointDoc,
): MapDrop {
  const point = mapPointAt(map, client, doc);
  if (!point) return { kind: 'none', reason: 'off_map' };
  if (!fieldsQueryable(map)) {
    const ll = map.unproject(point);
    return { kind: 'point', lngLat: { lng: ll.lng, lat: ll.lat } };
  }
  const fieldId = fieldAt(map, point);
  return fieldId ? { kind: 'field', fieldId } : { kind: 'none', reason: 'no_field' };
}

/** What is really under the pointer where a card is let go (the drag overlay lets it through). */
export type PointTarget =
  | { kind: 'machine'; machineId: string }
  | { kind: 'person'; partyId: string }
  | { kind: 'map' }
  | { kind: 'none' };

/**
 * The drop target under a viewport point, from the live page (`elementFromPoint`): a chip the
 * finger is on (a chip scrolled out of its row, or under a sheet, is never hit), else the map
 * canvas, else nothing. A pointer drop goes by this, not by the droppables' measured rectangles,
 * which can lag behind a sheet that is still moving (dnd-kit's `over` decides keyboard drops).
 */
export function targetAt(doc: PointDoc, point: { x: number; y: number }): PointTarget {
  const el = doc.elementFromPoint(point.x, point.y);
  if (!el) return { kind: 'none' };
  const machine = el.closest('[data-testid="chip-machine"]');
  const machineId = machine?.getAttribute('data-machine-id');
  if (machineId) return { kind: 'machine', machineId };
  const person = el.closest('[data-testid="chip-person"]');
  const partyId = person?.getAttribute('data-party-id');
  if (partyId) return { kind: 'person', partyId };
  if (el.closest('.maplibregl-canvas-container')) return { kind: 'map' };
  return { kind: 'none' };
}

/** A MapLibre gesture handler (dragPan, touchZoomRotate). */
interface Handler {
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
}

/**
 * Turn the map's drag-pan and touch zoom/rotate off while a card is dragged over it, and return
 * how to put back exactly what was on (a handler someone else had turned off stays off).
 */
export function suspendMapGestures(map: {
  dragPan: Handler;
  touchZoomRotate: Handler;
}): () => void {
  const off: Handler[] = [];
  for (const h of [map.dragPan, map.touchZoomRotate]) {
    if (h.isEnabled()) {
      h.disable();
      off.push(h);
    }
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const h of off) h.enable();
  };
}
