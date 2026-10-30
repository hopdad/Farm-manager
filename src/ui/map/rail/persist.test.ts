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

  test('round-trip through storage, the soils mode included', () => {
    const s = memory();
    expect(
      saveRailPrefs(s, 'wall', {
        overrides: { soils: true, fleet: false },
        modes: { soils: 'hydgrp' },
        open: false,
      }),
    ).toBe(true);
    expect(loadRailPrefs(s, 'wall')).toEqual({
      overrides: { soils: true, fleet: false },
      modes: { soils: 'hydgrp' },
      open: false,
    });
    // Each variant remembers its own.
    expect(loadRailPrefs(s, 'phone')).toEqual({ overrides: {}, modes: {}, open: null });
  });

  test('tolerant parse: junk, foreign shapes, bad keys and non-booleans are dropped', () => {
    const none = { overrides: {}, modes: {}, open: null };
    expect(parseRailPrefs(null)).toEqual(none);
    expect(parseRailPrefs('not json')).toEqual(none);
    expect(parseRailPrefs('[1,2]')).toEqual(none);
    expect(
      parseRailPrefs(
        JSON.stringify({ overrides: { soils: true, 'Bad Key': true, parcels: 'yes' }, open: 'x' }),
      ),
    ).toEqual({ overrides: { soils: true }, modes: {}, open: null });
  });

  test('modes: well-formed ids kept as saved; bad keys, bad ids and non-strings dropped', () => {
    expect(
      parseRailPrefs(
        JSON.stringify({
          modes: { soils: 'nccpi', parcels: 'texture', 'Bad Key': 'type', naip: 3, tile: 'Type!' },
        }),
      ).modes,
    ).toEqual({ soils: 'nccpi', parcels: 'texture' });
    expect(parseRailPrefs(JSON.stringify({ modes: ['type'] })).modes).toEqual({});
    // A value saved before modes existed (M1) reads as "default modes".
    expect(parseRailPrefs(JSON.stringify({ overrides: { soils: true }, open: true }))).toEqual({
      overrides: { soils: true },
      modes: {},
      open: true,
    });
  });

  test('a storage that throws (private mode, locked kiosk) never breaks the rail', () => {
    const none = { overrides: {}, modes: {}, open: null };
    expect(loadRailPrefs(throwing, 'wall')).toEqual(none);
    expect(saveRailPrefs(throwing, 'wall', { overrides: {}, modes: {}, open: true })).toBe(false);
    expect(loadRailPrefs(null, 'wall')).toEqual(none);
    expect(saveRailPrefs(null, 'wall', { overrides: {}, modes: {}, open: true })).toBe(false);
  });
});
