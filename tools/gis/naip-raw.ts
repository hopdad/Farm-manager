/**
 * The raw download cache for the imagery builder's loaders (plan §5 "Offline rules"):
 *
 *   data/raw/<source>/<YYYY-MM-DD>[.<n>]/   one download run (UTC date; .2, .3 … for re-runs)
 *   data/raw/manifest.json                  every raw download of every source: URL, date,
 *                                           sha256, bytes, licence note (keyed by path)
 *
 * Used by `gis:naip` (exportImage tiles: one run directory per build, its `run.json` written
 * last) and `gis:parcels <FeatureServer URL>` (the paged GeoJSON as one file). The manifest uses
 * the same entry shape as the soils loader's (tools/gis/soils-raw.ts on m1/soils), so both write
 * one file; the integrator can fold the two helpers into tools/gis/raw.ts.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './files';

export const MANIFEST_FILE = 'manifest.json';

/** data/raw under the project. */
export function rawRoot(projectDir: string): string {
  return path.join(projectDir, 'data', 'raw');
}

export const manifestEntrySchema = z.strictObject({
  source: z.string().min(1),
  /** Relative to data/raw, forward slashes. */
  path: z.string().min(1),
  url: z.string().min(1),
  method: z.enum(['GET', 'POST']),
  requestSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  fetchedAt: z.iso.datetime({ offset: true }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  licence: z.string().min(1),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

const manifestSchema = z.object({ version: z.literal(1), entries: z.array(manifestEntrySchema) });

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** `<UTC date>` or `<UTC date>.<n>`: the first name not taken under data/raw/<source>. */
export async function newRunDir(root: string, source: string, now: Date): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(source)) throw new Error(`bad raw source '${source}'`);
  const base = path.join(root, source);
  await mkdir(base, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  for (let n = 1; n < 1000; n++) {
    const dir = path.join(base, n === 1 ? day : `${day}.${n}`);
    const exists = await stat(dir).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(dir);
      return dir;
    }
  }
  throw new Error(`too many ${source} runs for ${day} under ${base}`);
}

/** Add (or replace, by path) entries in data/raw/manifest.json, atomically. */
export async function recordDownloads(
  root: string,
  entries: readonly ManifestEntry[],
): Promise<void> {
  const file = path.join(root, MANIFEST_FILE);
  const text = await readFile(file, 'utf8').catch(() => null);
  const current = text
    ? manifestSchema.parse(JSON.parse(text))
    : { version: 1 as const, entries: [] };
  const byPath = new Map(current.entries.map((e) => [e.path, e]));
  for (const e of entries) byPath.set(e.path, manifestEntrySchema.parse(e));
  const sorted = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  await mkdir(root, { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
}

/** data/raw-relative path with forward slashes (the manifest's key on every OS). */
export function rawRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
