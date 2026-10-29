import { describe, expect, test } from 'vitest';
import { decodeMvt, encodeMvt, ringArea } from './mvt';

describe('MVT encoder/decoder', () => {
  test('round-trips layers, ids, properties and all three geometry types', () => {
    const buf = encodeMvt([
      {
        name: 'places',
        features: [
          {
            id: 7,
            geometry: { type: 'Point', points: [[100, 200]] },
            properties: { name: 'Adrian', population_rank: 9, ratio: 0.5, capital: false, n: -3 },
          },
        ],
      },
      {
        name: 'roads',
        extent: 512,
        features: [
          {
            geometry: {
              type: 'LineString',
              lines: [
                [
                  [0, 0],
                  [10, 0],
                  [10, 0],
                  [10, 10],
                ],
                [
                  [50, 50],
                  [60, 40],
                ],
              ],
            },
            properties: { kind: 'major_road' },
          },
        ],
      },
      {
        name: 'earth',
        features: [
          {
            // Given counter-clockwise on screen: the encoder flips it to positive area.
            geometry: {
              type: 'Polygon',
              polygons: [
                [
                  [
                    [0, 0],
                    [0, 100],
                    [100, 100],
                    [100, 0],
                    [0, 0],
                  ],
                  [
                    [10, 10],
                    [20, 10],
                    [20, 20],
                    [10, 20],
                  ],
                ],
              ],
            },
            properties: { kind: 'earth' },
          },
        ],
      },
    ]);
    const layers = decodeMvt(buf);
    expect(layers.map((l) => [l.name, l.version, l.extent])).toEqual([
      ['places', 2, 4096],
      ['roads', 2, 512],
      ['earth', 2, 4096],
    ]);
    const [places, roads, earth] = layers;
    expect(places?.features[0]).toEqual({
      id: 7,
      type: 'Point',
      properties: { name: 'Adrian', population_rank: 9, ratio: 0.5, capital: false, n: -3 },
      parts: [[[100, 200]]],
    });
    expect(roads?.features[0]?.type).toBe('LineString');
    expect(roads?.features[0]?.parts).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [
        [50, 50],
        [60, 40],
      ],
    ]);
    const rings = earth?.features[0]?.parts ?? [];
    expect(rings).toHaveLength(2);
    expect(ringArea(rings[0] ?? [])).toBeGreaterThan(0);
    expect(ringArea(rings[1] ?? [])).toBeLessThan(0);
  });

  test('drops degenerate geometry and empty features', () => {
    const buf = encodeMvt([
      {
        name: 'x',
        features: [
          { geometry: { type: 'LineString', lines: [[[1, 1]]] }, properties: {} },
          {
            geometry: {
              type: 'Polygon',
              polygons: [
                [
                  [
                    [0, 0],
                    [1, 1],
                    [2, 2],
                  ],
                ],
              ],
            },
            properties: {},
          },
        ],
      },
    ]);
    expect(decodeMvt(buf)[0]?.features).toEqual([]);
  });

  test('ringArea sign follows tile coordinates (y down)', () => {
    expect(
      ringArea([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBe(100);
  });
});
