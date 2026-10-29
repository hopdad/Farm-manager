import { beforeEach, describe, expect, test } from 'vitest';
import { isLayerVisible, useLayerVisibilityStore } from './visibility';

describe('layer visibility store', () => {
  beforeEach(() => useLayerVisibilityStore.getState().reset());

  test('defaults until someone chooses; toggle flips what is shown', () => {
    const s = () => useLayerVisibilityStore.getState();
    expect(isLayerVisible(s().overrides, 'soils', false)).toBe(false);
    s().toggle('soils', false);
    expect(isLayerVisible(s().overrides, 'soils', false)).toBe(true);
    s().toggle('fields', true);
    expect(isLayerVisible(s().overrides, 'fields', true)).toBe(false);
    s().set('fields', true);
    expect(isLayerVisible(s().overrides, 'fields', true)).toBe(true);
    s().hydrate({ parcels: true });
    expect(s().overrides).toEqual({ parcels: true });
    s().reset();
    expect(s().overrides).toEqual({});
  });
});
