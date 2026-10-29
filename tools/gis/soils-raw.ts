/**
 * The soils raw cache (plan §5 "Offline rules"). Owner: soils.
 *
 *   data/raw/soils/<YYYY-MM-DD>[.<n>]/          one download run (UTC date; .2, .3 … for re-runs)
 *     survey.json, MI091.stats.json, MI091.components.001.json, MI091.polygons.001.json, …
 *                                               each SDA reply byte for byte, never rewritten
 *     run.json                                  the run index, written LAST: which files, from
 *                                               which query, rows, bytes, sha256 (a run without
 *                                               it is incomplete and never loaded)
 *   data/raw/manifest.json                      every raw download of every source: URL, date,
 *                                               sha256, bytes, licence note (entries keyed by path)
 *
 * `pnpm gis:soils --offline` rebuilds the database from a run alone, after checking every file
 * against run.json's sha256 (so `ingest:all --offline` reproduces the same rows). The committed
 * fixture (tools/gis/fixtures/soils) is a run directory too.
 *
 * Integrator note: the manifest helpers here are generic; other gis:* loaders can share them
 * (e.g. moved to tools/gis/raw.ts at merge).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './files';

export const SOILS_RAW_SOURCE = 'soils';
export const RUN_INDEX_FILE = 'run.json';
export const MANIFEST_FILE = 'manifest.json';
export const SSURGO_LICENCE =
  'Public domain (U.S. Government work). Cite: Soil Survey Staff, Natural Resources Conservation Service, ' +
  'United States Department of Agriculture. Soil Survey Geographic (SSURGO) Database, via Soil Data Access.';

/** data/raw under the project. */
export function rawRoot(projectDir: string): string {
  return path.join(projectDir, 'data', 'raw');
}

export const RUN_FILE_KINDS = ['survey', 'stats', 'components', 'polygons'] as const;
export type RunFileKind = (typeof RUN_FILE_KINDS)[number];

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;

export const runFileSchema = z.strictObject({
  file: z.string().regex(FILE_NAME_RE),
  kind: z.enum(RUN_FILE_KINDS),
  /** Survey area of the file (null for the catalogue query that covers every area). */
  area: z.string().nullable(),
  /** The T-SQL sent (the request body is {format, query}). */
  query: z.string().min(1),
  rows: z.number().int().min(0),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fetchedAt: z.iso.datetime({ offset: true }),
});
export type RunFile = z.infer<typeof runFileSchema>;

export const runIndexSchema = z.strictObject({
  format: z.literal(1),
  source: z.literal(SOILS_RAW_SOURCE),
  /** The SDA endpoint the files came from. */
  service: z.string().min(1),
  /** The request format (SDA FORMAT). */
  requestFormat: z.string().min(1),
  nccpiRule: z.string().min(1),
  areas: z.array(z.string().regex(/^[A-Z]{2}\d{3}$/)).min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  complete: z.literal(true),
  /** Set only on synthetic fixtures: what they are (never real survey data). */
  fixture: z.string().min(1).optional(),
  files: z.array(runFileSchema).min(1),
});
export type RunIndex = z.infer<typeof runIndexSchema>;

export const manifestEntrySchema = z.strictObject({
  source: z.string().min(1),
  /** Relative to data/raw, forward slashes. */
  path: z.string().min(1),
  url: z.string().min(1),
  method: z.enum(['GET', 'POST']),
  /** sha256 of the request body for POSTs (the query lives in the run index). */
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

const manifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(manifestEntrySchema),
});

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** `<UTC date>` or `<UTC date>.<n>`: the first name not taken under data/raw/soils. */
export async function newRunDir(root: string, now: Date): Promise<string> {
  const base = path.join(root, SOILS_RAW_SOURCE);
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
  throw new Error(`too many soils runs for ${day} under ${base}`);
}

/** Write one reply verbatim; returns its checksum and size. */
export async function writeRunFile(
  dir: string,
  file: string,
  text: string,
): Promise<{ sha256: string; bytes: number }> {
  if (!FILE_NAME_RE.test(file)) throw new Error(`bad raw file name '${file}'`);
  const data = Buffer.from(text, 'utf8');
  await writeFileAtomic(path.join(dir, file), data);
  return { sha256: sha256Hex(data), bytes: data.byteLength };
}

export async function writeRunIndex(dir: string, index: RunIndex): Promise<void> {
  const valid = runIndexSchema.parse(index);
  await writeFileAtomic(path.join(dir, RUN_INDEX_FILE), `${JSON.stringify(valid, null, 2)}\n`);
}

export interface SoilsRun {
  dir: string;
  index: RunIndex;
  /** The file's text, checked against the index (sha256 and size). */
  read(file: RunFile): Promise<string>;
}

/** Open a run directory: run.json must be valid and complete; files are checked as read. */
export async function openRun(dir: string): Promise<SoilsRun> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, RUN_INDEX_FILE), 'utf8');
  } catch {
    throw new Error(`${dir} has no ${RUN_INDEX_FILE}: not a complete soils download`);
  }
  const parsed = runIndexSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${path.join(dir, RUN_INDEX_FILE)} is invalid: ${parsed.error.message}`);
  }
  const index = parsed.data;
  const names = new Set<string>();
  for (const f of index.files) {
    if (names.has(f.file)) throw new Error(`${RUN_INDEX_FILE} lists ${f.file} twice`);
    names.add(f.file);
  }
  return {
    dir,
    index,
    read: async (f) => {
      const data = await readFile(path.join(dir, f.file));
      const sha = sha256Hex(data);
      if (data.byteLength !== f.bytes || sha !== f.sha256) {
        throw new Error(
          `${path.join(dir, f.file)} does not match ${RUN_INDEX_FILE} (sha256 ${sha.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…): the cache was changed; download again`,
        );
      }
      return data.toString('utf8');
    },
  };
}

/** Complete runs under data/raw/soils, newest first (by finishedAt, then name). */
export async function listRuns(
  root: string,
): Promise<{ name: string; dir: string; index: RunIndex }[]> {
  const base = path.join(root, SOILS_RAW_SOURCE);
  const names = await readdir(base).catch(() => [] as string[]);
  const out: { name: string; dir: string; index: RunIndex }[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    try {
      const run = await openRun(dir);
      out.push({ name, dir, index: run.index });
    } catch {
      // incomplete or foreign directory: never a load candidate
    }
  }
  return out.sort(
    (a, b) => b.index.finishedAt.localeCompare(a.index.finishedAt) || b.name.localeCompare(a.name),
  );
}

/** Add or replace manifest entries (keyed by path), atomically. */
export async function upsertManifestEntries(
  root: string,
  entries: readonly ManifestEntry[],
): Promise<void> {
  const file = path.join(root, MANIFEST_FILE);
  let current: ManifestEntry[] = [];
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text !== null) {
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new Error(`${file} is not a valid raw manifest: ${parsed.error.message}`);
    current = parsed.data.entries;
  }
  const byPath = new Map(current.map((e) => [e.path, e]));
  for (const e of entries) byPath.set(e.path, manifestEntrySchema.parse(e));
  const merged = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  await mkdir(root, { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`);
}

/** `soils/<run>/<file>` with forward slashes (manifest paths are the same on Windows). */
export function manifestPath(root: string, dir: string, file: string): string {
  return path.relative(root, path.join(dir, file)).split(path.sep).join('/');
}
