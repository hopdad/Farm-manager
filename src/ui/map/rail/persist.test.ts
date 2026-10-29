import { describe, expect, test } from 'vitest';
import {
  loadRailPrefs,
  parseRailPrefs,
  RAIL_STORAGE_PREFIX,
  railStorageKey,
  type StorageLike,
  saveRailPrefs,
} from './persist';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const throwing: StorageLike = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
};

describe('rail prefs', () => {
  test('one key per variant', () => {
    expect(railStorageKey('wall')).toBe(`${RAIL_STORAGE_PREFIX}wall`);
    expect(railStorageKey('phone')).not.toBe(railStorageKey('wall'));
  });

  test('round-trip through storage', () => {
    const s = memory();
    expect(
      saveRailPrefs(s, 'wall', { overrides: { soils: true, fleet: false }, open: false }),
    ).toBe(true);
    expect(loadRailPrefs(s, 'wall')).toEqual({
      overrides: { soils: true, fleet: false },
      open: false,
    });
    expect(loadRailPrefs(s, 'phone')).toEqual({ overrides: {}, open: null });
  });

  test('tolerant parse: junk, foreign shapes, bad keys and non-booleans are dropped', () => {
    expect(parseRailPrefs(null)).toEqual({ overrides: {}, open: null });
    expect(parseRailPrefs('not json')).toEqual({ overrides: {}, open: null });
    expect(parseRailPrefs('[1,2]')).toEqual({ overrides: {}, open: null });
    expect(
      parseRailPrefs(
        JSON.stringify({ overrides: { soils: true, 'Bad Key': true, parcels: 'yes' }, open: 'x' }),
      ),
    ).toEqual({ overrides: { soils: true }, open: null });
  });

  test('a storage that throws (private mode, locked kiosk) never breaks the rail', () => {
    expect(loadRailPrefs(throwing, 'wall')).toEqual({ overrides: {}, open: null });
    expect(saveRailPrefs(throwing, 'wall', { overrides: {}, open: true })).toBe(false);
    expect(loadRailPrefs(null, 'wall')).toEqual({ overrides: {}, open: null });
    expect(saveRailPrefs(null, 'wall', { overrides: {}, open: true })).toBe(false);
  });
});
