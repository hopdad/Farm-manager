/**
 * What a tap on the war-room map opens (1f seam, docs/contracts-1f.md §5.2): a machine wins,
 * then a feature of one of the `tapLayers` (deere-data's pins: `layer:pins:*`), then the field
 * under the finger (the field panel), else the empty map (`fieldId: null`: WarRoomMap calls
 * onFieldTap(null), then onEmptyTap, the soil map unit sheet). Pure, so the order is
 * unit-tested; WarRoomMap (./WarRoomMap.tsx) does the picking and calls the matching handler
 * only. The board switches handlers off by mode: while the tile-line tool draws, no pin, field
 * or empty-map tap; while it is open at all, no soil sheet on an empty-map tap (its taps select
 * its lines).
 *
 * `tapLayers` patterns are MapLibre layer ids, or a prefix ending in `*` (`layer:pins:*` matches
 * every layer of the pins def, src/ui/map/layers/types.ts `layerIdPrefix`). A pattern that
 * matches no layer on the map is ignored (the layer is hidden or not added yet).
 */

/** A feature of one of the tap layers under the finger. */
export interface FeatureTap {
  /** The MapLibre layer it was drawn by, e.g. 'layer:pins:points'. */
  layerId: string;
  /** `properties.id` when it is a string (the convention of every app layer), else null. */
  id: string | null;
  properties: Readonly<Record<string, unknown>>;
  /** Where the tap landed. */
  lngLat: { lng: number; lat: number };
}

export type TapTarget =
  | { kind: 'machine'; machineId: string }
  | { kind: 'feature'; feature: FeatureTap }
  | { kind: 'field'; fieldId: string | null };

/** True when `layerId` matches one of the patterns (exact id, or prefix + '*'). */
export function matchesTapLayer(layerId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) =>
    p.endsWith('*') ? layerId.startsWith(p.slice(0, -1)) : layerId === p,
  );
}

/** The ids of the map's layers the patterns match, in style order (what to query). */
export function tapLayerIds(
  patterns: readonly string[],
  styleLayerIds: readonly string[],
): string[] {
  if (patterns.length === 0) return [];
  return styleLayerIds.filter((id) => matchesTapLayer(id, patterns));
}

/**
 * The precedence: machine > tap-layer feature (the topmost, as MapLibre returns them) > field.
 * `fieldAt` runs only when nothing above it was hit (it queries the rendered fields fill).
 */
export function resolveTap(
  machineId: string | null,
  features: readonly FeatureTap[],
  fieldAt: () => string | null,
): TapTarget {
  if (machineId) return { kind: 'machine', machineId };
  const top = features[0];
  if (top) return { kind: 'feature', feature: top };
  return { kind: 'field', fieldId: fieldAt() };
}

/** A rendered MapLibre feature as a FeatureTap. */
export function toFeatureTap(
  f: { layer?: { id?: string }; properties?: Record<string, unknown> | null },
  lngLat: { lng: number; lat: number },
): FeatureTap | null {
  const layerId = f.layer?.id;
  if (!layerId) return null;
  const properties = f.properties ?? {};
  const id = typeof properties.id === 'string' ? properties.id : null;
  return { layerId, id, properties, lngLat };
}
