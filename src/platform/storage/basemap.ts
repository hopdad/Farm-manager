/**
 * `tiles/basemap.json`: which offline basemap is installed (contracts §10). Written last and
 * atomically by `pnpm gis:basemap` (tools/gis/basemap.ts); read by the board's server component
 * through the storage adapter. It is the lookup until `gis.map_layers` exists (1d).
 *
 * Pure schema + helpers; the reader takes any StorageReader.
 */
import { z } from 'zod';
import { contentHashOf, parseStorageKey } from './keys';
import type { StorageReader } from './types';

export const BASEMAP_BUCKET = 'tiles' as const;
export const BASEMAP_MANIFEST_KEY = 'basemap.json';
/** Fonts: `assets/fonts/<fontstack>/<range>.pbf`. */
export const BASEMAP_FONTS_PREFIX = 'assets/fonts';
/** Sprites: `assets/sprites/v4/<flavor>[@2x].{json,png}` (the basemaps-assets layout). */
export const BASEMAP_SPRITES_PREFIX = 'assets/sprites/v4';

/** The area of the offline extract (plan §2 step 6): [minLon, minLat, maxLon, maxLat]. */
export const BASEMAP_BBOX = [-84.45, 41.65, -83.1, 42.15] as const;
export const BASEMAP_MAXZOOM = 15;

const bbox = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

export const basemapManifestSchema = z
  .object({
    /** `basemap.<sha8>.pmtiles`, a key in the `tiles` bucket. */
    key: z.string().refine((k) => {
      try {
        return parseStorageKey(k) === k && /^basemap\.[0-9a-f]{8}\.pmtiles$/.test(k);
      } catch {
        return false;
      }
    }, 'must be basemap.<sha8>.pmtiles'),
    /** First 8 hex of the file's sha256. */
    sha8: z.string().regex(/^[0-9a-f]{8}$/),
    /** File size in bytes. */
    bytes: z.number().int().positive(),
    /** When the extract was installed (ISO-8601). */
    builtAt: z.iso.datetime({ offset: true }),
    /**
     * Where the tiles came from: a Protomaps build key (`20261028.pmtiles`), or `local:<name>`
     * for a local source file (`pnpm gis:basemap --source=<file>`, e.g. the synthetic fixture).
     */
    build: z.string().min(1),
    bbox,
    maxzoom: z.number().int().min(0).max(22),
    /** protomaps/basemaps-assets commit the fonts and sprites came from. */
    assetsCommit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .refine((m) => contentHashOf(m.key) === m.sha8, {
    message: 'key and sha8 disagree',
    path: ['sha8'],
  });

export type BasemapManifest = z.infer<typeof basemapManifestSchema>;

/** True when the manifest names a synthetic test fixture rather than a Protomaps build. */
export function isSyntheticBasemap(m: Pick<BasemapManifest, 'build'>): boolean {
  return m.build.startsWith('local:synthetic');
}

export type BasemapStatus =
  | { ok: true; manifest: BasemapManifest }
  | { ok: false; reason: 'missing' | 'invalid' | 'file-missing'; detail: string };

/**
 * Read and validate basemap.json and check the file it names exists with the recorded size.
 * Never throws for missing/invalid data (the board then shows the "basemap missing" badge).
 */
export async function readBasemapStatus(storage: StorageReader): Promise<BasemapStatus> {
  let text: string | null;
  try {
    text = await storage.readText(BASEMAP_BUCKET, BASEMAP_MANIFEST_KEY);
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: (e as Error).message };
  }
  if (text === null) {
    return { ok: false, reason: 'missing', detail: 'tiles/basemap.json does not exist' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: `basemap.json: ${(e as Error).message}` };
  }
  const parsed = basemapManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, reason: 'invalid', detail: `basemap.json: ${issues.join('; ')}` };
  }
  const info = await storage.stat(BASEMAP_BUCKET, parsed.data.key);
  if (!info || info.size !== parsed.data.bytes) {
    return {
      ok: false,
      reason: 'file-missing',
      detail: `tiles/${parsed.data.key} is ${info ? `${info.size} bytes, expected ${parsed.data.bytes}` : 'missing'}`,
    };
  }
  return { ok: true, manifest: parsed.data };
}
