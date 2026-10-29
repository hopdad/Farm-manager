import { describe, expect, test } from 'vitest';
import {
  contentAddressedName,
  contentHashOf,
  isStorageBucket,
  parseStorageKey,
  StorageKeyError,
  tryParseStorageKey,
} from './keys';

describe('parseStorageKey', () => {
  test.each([
    ['basemap.1a2b3c4d.pmtiles', 'basemap.1a2b3c4d.pmtiles'],
    ['basemap.json', 'basemap.json'],
    ['assets/fonts/Noto Sans Regular/0-255.pbf', 'assets/fonts/Noto Sans Regular/0-255.pbf'],
    ['assets/sprites/v4/light@2x.png', 'assets/sprites/v4/light@2x.png'],
  ])('accepts %s', (key, expected) => {
    expect(parseStorageKey(key)).toBe(expected);
  });

  test('joins route segments', () => {
    expect(parseStorageKey(['assets', 'fonts', 'Noto Sans Medium', '256-511.pbf'])).toBe(
      'assets/fonts/Noto Sans Medium/256-511.pbf',
    );
  });

  test.each([
    ['', 'empty key'],
    ['../secret', "'..' segment"],
    ['assets/../../etc/passwd', "'..' segment"],
    ['./basemap.json', "'.' segment"],
    ['assets//x.pbf', 'empty path segment'],
    ['assets/', 'empty path segment'],
    ['/etc/passwd', 'absolute key'],
    ['assets\\..\\x', 'backslash in key'],
    ['C:/Windows/win.ini', 'drive letter in key'],
    ['c:x', 'drive letter in key'],
    ['a\u0000b', 'control character in key'],
    ['a\nb', 'control character in key'],
    ['assets/a:b', 'reserved character in key'],
    ['assets/x?.pbf', 'reserved character in key'],
    ['assets/CON', 'reserved file name in key'],
    ['assets/nul.json', 'reserved file name in key'],
    ['assets/x.', 'path segment ends with a dot or space'],
    ['assets/x ', 'path segment ends with a dot or space'],
    ['a'.repeat(600), 'key too long'],
  ])('rejects %j (%s)', (key, reason) => {
    expect(() => parseStorageKey(key)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(key)).toThrow(reason);
  });

  test('rejects traversal hidden in route segments', () => {
    expect(() => parseStorageKey(['assets', '..', '..', 'x'])).toThrow(StorageKeyError);
    expect(() => parseStorageKey(['a/../b'])).toThrow(StorageKeyError);
  });

  test('tryParseStorageKey returns null for bad keys', () => {
    expect(tryParseStorageKey('../x')).toBeNull();
    expect(tryParseStorageKey('ok.json')).toBe('ok.json');
  });
});

describe('content-addressed keys', () => {
  test('contentHashOf finds the sha8 in the last segment only', () => {
    expect(contentHashOf('basemap.1a2b3c4d.pmtiles')).toBe('1a2b3c4d');
    expect(contentHashOf('layers/hillshade.deadbeef.pmtiles')).toBe('deadbeef');
    expect(contentHashOf('basemap.json')).toBeNull();
    expect(contentHashOf('basemap.1A2B3C4D.pmtiles')).toBeNull();
    expect(contentHashOf('x.1a2b3c4d/basemap.json')).toBeNull();
    expect(contentHashOf('assets/fonts/Noto Sans Regular/0-255.pbf')).toBeNull();
  });

  test('contentAddressedName uses the first 8 hex of the digest', () => {
    const sha = 'ab'.repeat(32);
    expect(contentAddressedName('basemap', sha, 'pmtiles')).toBe('basemap.abababab.pmtiles');
    expect(() => contentAddressedName('basemap', 'xyz', 'pmtiles')).toThrow();
    expect(() => contentAddressedName('../x', sha, 'pmtiles')).toThrow();
  });

  test('buckets', () => {
    expect(isStorageBucket('tiles')).toBe(true);
    expect(isStorageBucket('uploads')).toBe(true);
    expect(isStorageBucket('secrets')).toBe(false);
  });
});
