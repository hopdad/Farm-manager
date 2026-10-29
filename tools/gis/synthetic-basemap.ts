/**
 * Synthetic SE Michigan basemap: a small PMTiles archive in the Protomaps v4 tile schema (the
 * layers @protomaps/basemaps 5.x styles: earth, water, roads, places, boundaries), built offline
 * from a handful of hand-placed features. A TEST FIXTURE for CI, e2e and machines that can't
 * reach build.protomaps.com; never a substitute for the real extract.
 *
 *   pnpm exec tsx tools/gis/synthetic-basemap.ts <out.pmtiles>
 *   pnpm gis:basemap --source=<out.pmtiles>     # installs it like a real build (build "local:synthetic-…")
 *
 * Town positions are approximate and the roads, river, lake shore and state line are crude
 * polylines; the 1-mile section-line grid is regular. The board marks it "synthetic basemap".
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { isMainModule } from '../../src/lib/proc';
import { BASEMAP_BBOX } from '../../src/platform/storage/basemap';
import {
  type BBox,
  bboxCenter,
  bboxesIntersect,
  lngLatToWorld,
  type TileCoord,
  tilesCoveringBBox,
  tileToBBox,
} from '../../src/ui/map/tile-math';
import { type ClipBox, clipLine, clipRing, type Pt } from './clip';
import { encodeMvt, type MvtFeature, type MvtLayer, type MvtValue } from './mvt';
import { PmCompression, PmTileType, writePmtiles } from './pmtiles-writer';

/** `build` recorded in basemap.json when this fixture is installed. */
export const SYNTHETIC_BUILD_PREFIX = 'local:synthetic';
export const SYNTHETIC_FILE_NAME = 'synthetic-se-michigan.pmtiles';
export const SYNTHETIC_MAX_ZOOM = 13;

const EXTENT = 4096;
const BUFFER = 64;

type LngLat = readonly [number, number];

interface SourceFeature {
  layer: 'earth' | 'water' | 'roads' | 'places' | 'boundaries';
  minZoom: number;
  kind: 'point' | 'line' | 'polygon';
  coords: LngLat[];
  properties: Record<string, MvtValue>;
}

/** [name, lat, lng, min_zoom, population_rank] — approximate town centres. */
const TOWNS: [string, number, number, number, number][] = [
  ['Toledo', 41.6528, -83.5379, 6, 12],
  ['Adrian', 41.8975, -84.0372, 7, 9],
  ['Monroe', 41.9164, -83.3977, 7, 9],
  ['Tecumseh', 42.0039, -83.945, 8, 8],
  ['Sylvania', 41.7189, -83.713, 9, 8],
  ['Blissfield', 41.8323, -83.8627, 9, 7],
  ['Hudson', 41.855, -84.3539, 9, 7],
  ['Dundee', 41.9572, -83.6596, 9, 7],
  ['Milan', 42.0853, -83.6824, 9, 7],
  ['Temperance', 41.7792, -83.5688, 9, 7],
  ['Clinton', 42.0717, -83.9716, 10, 6],
  ['Morenci', 41.7198, -84.218, 10, 6],
  ['Lambertville', 41.7659, -83.628, 10, 6],
  ['Deerfield', 41.889, -83.7716, 11, 5],
  ['Petersburg', 41.9006, -83.7149, 11, 5],
  ['Britton', 41.9873, -83.8299, 11, 5],
  ['Onsted', 42.0059, -84.1919, 11, 5],
  ['Ida', 41.9128, -83.5713, 11, 5],
  ['Addison', 41.9862, -84.3472, 11, 5],
  ['Palmyra', 41.8629, -83.9624, 11, 4],
  ['Riga', 41.8106, -83.8191, 11, 4],
  ['Maybee', 42.0034, -83.5155, 11, 4],
  ['Erie', 41.7856, -83.4955, 11, 4],
];

const ROADS: { name: string; kind: 'highway' | 'major_road'; minZoom: number; line: LngLat[] }[] = [
  {
    name: 'I 75',
    kind: 'highway',
    minZoom: 5,
    line: [
      [-83.48, 41.65],
      [-83.43, 41.78],
      [-83.4, 41.88],
      [-83.36, 41.95],
      [-83.3, 42.03],
      [-83.24, 42.15],
    ],
  },
  {
    name: 'US 23',
    kind: 'highway',
    minZoom: 5,
    line: [
      [-83.7, 41.65],
      [-83.69, 41.77],
      [-83.67, 41.9],
      [-83.66, 41.957],
      [-83.68, 42.08],
      [-83.7, 42.15],
    ],
  },
  {
    name: 'US 223',
    kind: 'major_road',
    minZoom: 7,
    line: [
      [-83.7, 41.77],
      [-83.8, 41.81],
      [-83.8627, 41.833],
      [-83.95, 41.865],
      [-84.0372, 41.8975],
      [-84.15, 41.95],
      [-84.3, 42.02],
      [-84.42, 42.07],
    ],
  },
  {
    name: 'M 52',
    kind: 'major_road',
    minZoom: 7,
    line: [
      [-84.02, 41.7],
      [-84.0372, 41.8975],
      [-84.04, 42.15],
    ],
  },
  {
    name: 'M 50',
    kind: 'major_road',
    minZoom: 7,
    line: [
      [-84.19, 42.006],
      [-83.945, 42.0039],
      [-83.8, 41.99],
      [-83.6596, 41.9572],
      [-83.52, 41.94],
      [-83.3977, 41.9164],
    ],
  },
  {
    name: 'US 12',
    kind: 'major_road',
    minZoom: 7,
    line: [
      [-84.4, 42.06],
      [-84.2, 42.07],
      [-83.9716, 42.0717],
      [-83.78, 42.15],
    ],
  },
];

const RIVER_RAISIN: LngLat[] = [
  [-84.04, 42.15],
  [-83.97, 42.07],
  [-83.95, 42.0],
  [-83.9, 41.93],
  [-83.86, 41.84],
  [-83.8, 41.87],
  [-83.77, 41.889],
  [-83.71, 41.9],
  [-83.66, 41.955],
  [-83.52, 41.93],
  [-83.4, 41.912],
  [-83.35, 41.9],
];

const LAKE_ERIE: LngLat[] = [
  [-83.47, 41.65],
  [-83.1, 41.65],
  [-83.1, 42.04],
  [-83.17, 42.05],
  [-83.21, 42.02],
  [-83.26, 41.97],
  [-83.33, 41.92],
  [-83.38, 41.86],
  [-83.42, 41.78],
  [-83.46, 41.71],
  [-83.47, 41.65],
];

const STATE_LINE: LngLat[] = [
  [-84.45, 41.6965],
  [-83.453, 41.7325],
];

/** One statute mile in degrees at the AOI's latitude. */
const MILE_LAT = 1609.344 / 111_050;
const MILE_LNG = 1609.344 / 82_950;

/** Every feature of the fixture, in WGS84. */
export function syntheticFeatures(bbox: BBox = BASEMAP_BBOX): SourceFeature[] {
  const [w, s, e, n] = bbox;
  const out: SourceFeature[] = [
    {
      layer: 'earth',
      minZoom: 0,
      kind: 'polygon',
      coords: [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
      properties: { kind: 'earth' },
    },
    {
      layer: 'water',
      minZoom: 0,
      kind: 'polygon',
      coords: LAKE_ERIE,
      properties: { kind: 'lake', name: 'Lake Erie', min_zoom: 0 },
    },
    {
      layer: 'water',
      minZoom: 9,
      kind: 'line',
      coords: RIVER_RAISIN,
      properties: { kind: 'river', name: 'River Raisin', min_zoom: 9 },
    },
    {
      layer: 'boundaries',
      minZoom: 0,
      kind: 'line',
      coords: STATE_LINE,
      properties: { kind: 'region', kind_detail: 4, min_zoom: 0 },
    },
  ];
  for (const r of ROADS) {
    out.push({
      layer: 'roads',
      minZoom: r.minZoom,
      kind: 'line',
      coords: r.line,
      properties: {
        kind: r.kind,
        kind_detail: r.kind === 'highway' ? 'motorway' : 'primary',
        name: r.name,
        min_zoom: r.minZoom,
      },
    });
  }
  // The 1-mile section-line grid (unnamed minor roads).
  for (let x = w + MILE_LNG; x < e; x += MILE_LNG) {
    out.push(gridRoad([x, s], [x, n]));
  }
  for (let y = s + MILE_LAT; y < n; y += MILE_LAT) {
    out.push(gridRoad([w, y], [e, y]));
  }
  for (const [name, lat, lng, minZoom, rank] of TOWNS) {
    out.push({
      layer: 'places',
      minZoom,
      kind: 'point',
      coords: [[lng, lat]],
      properties: {
        kind: 'locality',
        name,
        'name:en': name,
        min_zoom: minZoom,
        population_rank: rank,
        sort_key: minZoom,
      },
    });
  }
  return out;
}

function gridRoad(a: LngLat, b: LngLat): SourceFeature {
  return {
    layer: 'roads',
    minZoom: 11,
    kind: 'line',
    coords: [a, b],
    properties: { kind: 'minor_road', kind_detail: 'unclassified', min_zoom: 11 },
  };
}

function bboxOf(coords: readonly LngLat[]): BBox {
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Tile pixel coordinates (unrounded) of a WGS84 point. */
function toPixel(c: LngLat, tile: TileCoord): Pt {
  const k = 2 ** tile.z;
  const [wx, wy] = lngLatToWorld(c[0], c[1]);
  return [(wx * k - tile.x) * EXTENT, (wy * k - tile.y) * EXTENT];
}

const LAYER_ORDER = ['earth', 'water', 'boundaries', 'roads', 'places'] as const;

/** Encode one tile (null when it would be empty). */
export function syntheticTile(
  features: readonly SourceFeature[],
  tile: TileCoord,
): Uint8Array | null {
  const box: ClipBox = {
    minX: -BUFFER,
    minY: -BUFFER,
    maxX: EXTENT + BUFFER,
    maxY: EXTENT + BUFFER,
  };
  const tb = tileToBBox(tile);
  const byLayer = new Map<string, MvtFeature[]>();
  for (const f of features) {
    if (tile.z < f.minZoom || !bboxesIntersect(bboxOf(f.coords), tb)) continue;
    const px = f.coords.map((c) => toPixel(c, tile));
    let feature: MvtFeature | null = null;
    if (f.kind === 'point') {
      const pts = px.filter((p) => p[0] >= 0 && p[0] < EXTENT && p[1] >= 0 && p[1] < EXTENT);
      if (pts.length)
        feature = { geometry: { type: 'Point', points: pts }, properties: f.properties };
    } else if (f.kind === 'line') {
      const lines = clipLine(px, box);
      if (lines.length)
        feature = { geometry: { type: 'LineString', lines }, properties: f.properties };
    } else {
      const ring = clipRing(px, box);
      if (ring.length) {
        feature = { geometry: { type: 'Polygon', polygons: [[ring]] }, properties: f.properties };
      }
    }
    if (feature) {
      const list = byLayer.get(f.layer) ?? [];
      list.push(feature);
      byLayer.set(f.layer, list);
    }
  }
  const layers: MvtLayer[] = LAYER_ORDER.filter((l) => byLayer.has(l)).map((name) => ({
    name,
    extent: EXTENT,
    features: byLayer.get(name) ?? [],
  }));
  return layers.length ? encodeMvt(layers) : null;
}

/** Build the whole archive (deterministic for a given Node/zlib build). */
export function buildSyntheticBasemap(opts: { bbox?: BBox; maxZoom?: number } = {}): Buffer {
  const bbox = opts.bbox ?? BASEMAP_BBOX;
  const maxZoom = opts.maxZoom ?? SYNTHETIC_MAX_ZOOM;
  const features = syntheticFeatures(bbox);
  const tiles = [];
  for (let z = 0; z <= maxZoom; z++) {
    for (const t of tilesCoveringBBox(bbox, z)) {
      const mvt = syntheticTile(features, t);
      if (mvt) tiles.push({ ...t, data: gzipSync(mvt, { level: 9 }) });
    }
  }
  const [cx, cy] = bboxCenter(bbox);
  return writePmtiles(tiles, {
    tileType: PmTileType.Mvt,
    tileCompression: PmCompression.Gzip,
    bounds: bbox,
    center: [cx, cy, 10],
    metadata: {
      name: 'Synthetic SE Michigan (test fixture)',
      description:
        'Hand-placed towns, approximate roads and a 1-mile section grid in the Protomaps v4 schema. Not real map data.',
      attribution: 'Synthetic test data (not OpenStreetMap)',
      type: 'baselayer',
      version: '4.0.0-synthetic',
      vector_layers: LAYER_ORDER.map((id) => ({ id, fields: {} })),
    },
  });
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: tsx tools/gis/synthetic-basemap.ts <out.pmtiles>');
    process.exit(2);
  }
  const buf = buildSyntheticBasemap();
  await writeFile(path.resolve(out), buf);
  console.log(`[gis] wrote ${path.resolve(out)} (${buf.length} bytes, synthetic test fixture)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`[gis] synthetic basemap failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
