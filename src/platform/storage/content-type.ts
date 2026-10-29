/** Content-Type by file extension for storage objects (contracts §10). Pure. */

const TYPES: Record<string, string> = {
  pmtiles: 'application/vnd.pmtiles',
  pbf: 'application/x-protobuf',
  mvt: 'application/vnd.mapbox-vector-tile',
  json: 'application/json',
  geojson: 'application/geo+json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeFor(key: string): string {
  const last = key.slice(key.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_CONTENT_TYPE;
  return TYPES[last.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}
