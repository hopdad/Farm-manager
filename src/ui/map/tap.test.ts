/**
 * The map's tap precedence (1f seam, docs/contracts-1f.md §5.2): machine > a feature of the tap
 * layers (deere-data's pins, `layer:pins:*`) > the field under the finger; no tap layers = the
 * 1a behaviour (machine, else field).
 */
import { describe, expect, test } from 'vitest';
import { type FeatureTap, matchesTapLayer, resolveTap, tapLayerIds, toFeatureTap } from './tap';

const at = { lng: -84.05, lat: 41.9 };
const pin: FeatureTap = { layerId: 'layer:pins:points', id: 'pin-1', properties: {}, lngLat: at };

describe('map tap precedence', () => {
  test('a machine wins over a pin and a field (the field is not even queried)', () => {
    let queried = false;
    const t = resolveTap('machine-1', [pin], () => {
      queried = true;
      return 'field-1';
    });
    expect(t).toEqual({ kind: 'machine', machineId: 'machine-1' });
    expect(queried).toBe(false);
  });

  test('a pin wins over the field under it', () => {
    let queried = false;
    const t = resolveTap(null, [pin], () => {
      queried = true;
      return 'field-1';
    });
    expect(t).toEqual({ kind: 'feature', feature: pin });
    expect(queried).toBe(false);
  });

  test('no machine and no pin: the field, or empty map', () => {
    expect(resolveTap(null, [], () => 'field-1')).toEqual({ kind: 'field', fieldId: 'field-1' });
    expect(resolveTap(null, [], () => null)).toEqual({ kind: 'field', fieldId: null });
  });

  test('the topmost feature wins when several are under the finger', () => {
    const line = { ...pin, layerId: 'layer:pins:lines', id: 'pin-2' };
    expect(resolveTap(null, [line, pin], () => null)).toEqual({ kind: 'feature', feature: line });
  });

  test('patterns: exact ids and prefixes ending in *; none = nothing to query', () => {
    const style = ['fields-fill', 'layer:pins:polygons', 'layer:pins:points', 'layer:soils:fill'];
    expect(tapLayerIds(['layer:pins:*'], style)).toEqual([
      'layer:pins:polygons',
      'layer:pins:points',
    ]);
    expect(tapLayerIds(['layer:soils:fill', 'layer:nope'], style)).toEqual(['layer:soils:fill']);
    expect(tapLayerIds([], style)).toEqual([]);
    expect(matchesTapLayer('layer:pinsx:points', ['layer:pins:*'])).toBe(false);
  });

  test('a rendered feature becomes a FeatureTap with its string id', () => {
    expect(
      toFeatureTap(
        { layer: { id: 'layer:pins:points' }, properties: { id: 'p', kind: 'rock' } },
        at,
      ),
    ).toEqual({
      layerId: 'layer:pins:points',
      id: 'p',
      properties: { id: 'p', kind: 'rock' },
      lngLat: at,
    });
    expect(toFeatureTap({ layer: { id: 'x' }, properties: { id: 7 } }, at)?.id).toBeNull();
    expect(toFeatureTap({ properties: {} }, at)).toBeNull();
  });
});
