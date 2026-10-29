import { describe, expect, test } from 'vitest';
import { parseEwkbHex } from './geo';
import { parseTstzRange } from './range';

// Fixtures produced by PostGIS 3.3.7 (supabase/postgres:17.11.0.008).
describe('parseEwkbHex', () => {
  test('Point with SRID', () => {
    expect(parseEwkbHex('0101000020E610000051DA1B7C610255C07B14AE47E1F24440')).toEqual({
      type: 'Point',
      coordinates: [-84.0372, 41.8975],
    });
  });

  test('MultiPolygon with two parts', () => {
    const g = parseEwkbHex(
      '0106000020E6100000020000000103000000010000000500000033333333330355C03333333333F34440C3F5285C8F0255C03333333333F34440C3F5285C8F0255C014AE47E17AF4444033333333330355C014AE47E17AF4444033333333330355C03333333333F344400103000000010000000400000052B81E85EB0155C03333333333F34440E17A14AE470155C03333333333F34440E17A14AE470155C014AE47E17AF4444052B81E85EB0155C03333333333F34440',
    );
    expect(g).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-84.05, 41.9],
            [-84.04, 41.9],
            [-84.04, 41.91],
            [-84.05, 41.91],
            [-84.05, 41.9],
          ],
        ],
        [
          [
            [-84.03, 41.9],
            [-84.02, 41.9],
            [-84.02, 41.91],
            [-84.03, 41.9],
          ],
        ],
      ],
    });
  });

  test('Polygon with a hole', () => {
    const g = parseEwkbHex(
      '0103000020E6100000020000000500000000000000000000000000000000000000000000000000F03F0000000000000000000000000000F03F000000000000F03F0000000000000000000000000000F03F00000000000000000000000000000000040000009A9999999999C93F9A9999999999C93F9A9999999999D93F9A9999999999C93F9A9999999999D93F9A9999999999D93F9A9999999999C93F9A9999999999C93F',
    );
    expect(g.type).toBe('Polygon');
    if (g.type !== 'Polygon') return;
    expect(g.coordinates).toHaveLength(2);
    expect(g.coordinates[1]?.[1]).toEqual([0.4, 0.2]);
  });

  test('LineString Z keeps z', () => {
    expect(
      parseEwkbHex(
        '01020000A0E610000002000000000000000000F03F00000000000000400000000000000840000000000000104000000000000014400000000000001840',
      ),
    ).toEqual({
      type: 'LineString',
      coordinates: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
  });

  test('plain WKB and \\x-prefixed bytea text', () => {
    expect(parseEwkbHex('\\x0101000000000000000000f03f0000000000000040')).toEqual({
      type: 'Point',
      coordinates: [1, 2],
    });
  });

  test('rejects garbage', () => {
    expect(() => parseEwkbHex('zz')).toThrow();
    expect(() => parseEwkbHex('0101000000000000000000f03f000000000000004000')).toThrow(/trailing/);
  });
});

describe('parseTstzRange', () => {
  test('open upper bound', () => {
    const r = parseTstzRange('["2026-10-29 00:05:22.692907+00",)');
    expect(r.from?.toISOString()).toBe('2026-10-29T00:05:22.692Z');
    expect(r.to).toBeNull();
  });

  test('both bounds, non-UTC offset', () => {
    const r = parseTstzRange('["2026-01-01 00:00:00-05","2026-06-01 00:00:00-04")');
    expect(r.from?.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(r.to?.toISOString()).toBe('2026-06-01T04:00:00.000Z');
  });

  test('unbounded lower', () => {
    expect(parseTstzRange('(,"2026-01-01 00:00:00+00")').from).toBeNull();
  });
});
