/**
 * Fonts and sprites for the offline basemap (contracts §10), mirrored from a pinned commit of
 * protomaps/basemaps-assets into `<storage>/tiles/assets/` with the same layout:
 *
 *   assets/fonts/<fontstack>/<start>-<end>.pbf     every 256-glyph range of each font stack
 *   assets/sprites/v4/<flavor>[@2x].{json,png}     the v4 sprites @protomaps/basemaps 5.x uses
 *   assets/fonts/OFL.txt                           the fonts' licence
 *   assets/manifest.json                           { commit, files: { path: { bytes, sha256 } } }
 *
 * Idempotent: when manifest.json names the pinned commit and every file is present with its
 * recorded size, nothing is downloaded. Missing or damaged files are fetched again. Any failed
 * download fails the run (no partial manifest).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './files';
import { describeError, downloadToFile, type FetchLike } from './http';

/** protomaps/basemaps-assets main as of Oct 29, 2026 (sprites v4; Noto Sans fonts). */
export const BASEMAPS_ASSETS_COMMIT = '028c18f713baecad011301ff7a69acc39bcc2ae7';
export const BASEMAPS_ASSETS_BASE = 'https://raw.githubusercontent.com/protomaps/basemaps-assets';

/** Every `text-font` the pinned @protomaps/basemaps style can ask for (src/base_layers.ts, language.ts). */
export const FONT_STACKS = [
  'Noto Sans Regular',
  'Noto Sans Medium',
  'Noto Sans Italic',
  'Noto Sans Devanagari Regular v1',
] as const;
export const SPRITE_FLAVORS = ['light', 'dark', 'white', 'grayscale', 'black'] as const;

export const ASSETS_MANIFEST = 'manifest.json';

/** Glyph ranges MapLibre requests: 0-255, 256-511, …, 65280-65535. */
export function glyphRanges(): string[] {
  return Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}`);
}

/** Every asset path, relative to the repo root and to `tiles/assets/`. */
export function assetPaths(): string[] {
  const out: string[] = ['fonts/OFL.txt'];
  for (const stack of FONT_STACKS) {
    for (const range of glyphRanges()) out.push(`fonts/${stack}/${range}.pbf`);
  }
  for (const flavor of SPRITE_FLAVORS) {
    for (const scale of ['', '@2x']) {
      for (const ext of ['json', 'png']) out.push(`sprites/v4/${flavor}${scale}.${ext}`);
    }
  }
  return out;
}

export function assetUrl(relPath: string, commit = BASEMAPS_ASSETS_COMMIT): string {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${BASEMAPS_ASSETS_BASE}/${commit}/${encoded}`;
}

const manifestSchema = z.object({
  commit: z.string(),
  files: z.record(z.string(), z.object({ bytes: z.number().int().min(0), sha256: z.string() })),
});
export type AssetsManifest = z.infer<typeof manifestSchema>;

async function readManifest(assetsDir: string): Promise<AssetsManifest | null> {
  try {
    return manifestSchema.parse(
      JSON.parse(await readFile(path.join(assetsDir, ASSETS_MANIFEST), 'utf8')),
    );
  } catch {
    return null;
  }
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** Which assets still need downloading for `commit` (all of them without a matching manifest). */
export async function missingAssets(
  assetsDir: string,
  commit = BASEMAPS_ASSETS_COMMIT,
  paths = assetPaths(),
): Promise<string[]> {
  const manifest = await readManifest(assetsDir);
  if (!manifest || manifest.commit !== commit) return paths;
  const missing: string[] = [];
  for (const p of paths) {
    const rec = manifest.files[p];
    const size = await sizeOf(path.join(assetsDir, ...p.split('/')));
    if (!rec || size === null || size !== rec.bytes) missing.push(p);
  }
  return missing;
}

async function hashFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export interface SyncAssetsResult {
  commit: string;
  downloaded: number;
  total: number;
  bytes: number;
}

/** Make `<assetsDir>` match the pinned commit. Throws (listing the failures) if any file fails. */
export async function syncAssets(
  assetsDir: string,
  opts: {
    commit?: string;
    fetch?: FetchLike;
    concurrency?: number;
    log?: (msg: string) => void;
    paths?: string[];
  } = {},
): Promise<SyncAssetsResult> {
  const commit = opts.commit ?? BASEMAPS_ASSETS_COMMIT;
  const paths = opts.paths ?? assetPaths();
  const log = opts.log ?? (() => {});
  const todo = await missingAssets(assetsDir, commit, paths);
  const previous = await readManifest(assetsDir);
  const files: AssetsManifest['files'] = previous?.commit === commit ? { ...previous.files } : {};
  if (todo.length === 0) {
    const bytes = Object.values(files).reduce((n, f) => n + f.bytes, 0);
    return { commit, downloaded: 0, total: paths.length, bytes };
  }
  log(
    `downloading ${todo.length} of ${paths.length} font/sprite files (basemaps-assets@${commit.slice(0, 7)})`,
  );
  const failures: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const rel = todo[i];
      if (rel === undefined) return;
      const dest = path.join(assetsDir, ...rel.split('/'));
      const tmp = `${dest}.download`;
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        const bytes = await downloadToFile(assetUrl(rel, commit), tmp, {
          fetch: opts.fetch,
          timeoutMs: 60_000,
        });
        await rename(tmp, dest);
        files[rel] = { bytes, sha256: await hashFile(dest) };
      } catch (e) {
        await rm(tmp, { force: true });
        failures.push(`${rel}: ${describeError(e)}`);
      }
      done++;
      if (done % 128 === 0) log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 12 }, worker));
  if (failures.length) {
    const shown = failures.slice(0, 5).join('\n  - ');
    throw new Error(
      `${failures.length} asset download(s) failed:\n  - ${shown}${failures.length > 5 ? '\n  - …' : ''}`,
    );
  }
  for (const key of Object.keys(files)) if (!paths.includes(key)) delete files[key];
  await writeFileAtomic(
    path.join(assetsDir, ASSETS_MANIFEST),
    `${JSON.stringify({ commit, files } satisfies AssetsManifest, null, 2)}\n`,
  );
  const bytes = Object.values(files).reduce((n, f) => n + f.bytes, 0);
  return { commit, downloaded: todo.length, total: paths.length, bytes };
}
