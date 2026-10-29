/**
 * Protomaps daily builds (plan §2 step 6). The builds listing (the JSON behind
 * maps.protomaps.com/builds) has one entry per daily planet build: `{ key: 'YYYYMMDD.pmtiles',
 * size, uploaded, version }`, where `version` is the tileset schema version (4.x for the
 * @protomaps/basemaps 5.x style). Daily builds are kept for about a week; the first build of
 * each tileset version (the "patch-version build") is kept indefinitely. So the candidates are:
 *
 *   1. the newest build with a compatible version;
 *   2. then, newest version first, the earliest build of each compatible version.
 *
 * resolveBuild() probes them in that order with a 127-byte range request (the PMTiles header)
 * and returns the first that answers with a valid header.
 */
import { z } from 'zod';
import { describeError, type FetchLike, fetchWithRetry } from './http';

export const PROTOMAPS_BUILDS_URL = 'https://build-metadata.protomaps.dev/builds.json';
export const PROTOMAPS_BUILD_BASE = 'https://build.protomaps.com/';
/** Tileset major versions the pinned @protomaps/basemaps 5.x style renders. */
export const COMPATIBLE_TILESET_MAJORS = [4] as const;

const buildSchema = z.object({
  key: z.string().regex(/^\d{8}\.pmtiles$/),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  size: z.number().optional(),
  uploaded: z.string().optional(),
});
export type ProtomapsBuild = z.infer<typeof buildSchema>;

/** Validate the listing; entries that aren't planet .pmtiles builds are skipped. */
export function parseBuildsListing(json: unknown): ProtomapsBuild[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { builds?: unknown }).builds)
      ? (json as { builds: unknown[] }).builds
      : null;
  if (!list) throw new Error('builds listing is not an array');
  const builds: ProtomapsBuild[] = [];
  for (const item of list) {
    const r = buildSchema.safeParse(item);
    if (r.success) builds.push(r.data);
  }
  if (builds.length === 0) throw new Error('builds listing has no usable entries');
  return builds;
}

function semver(v: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = v.split(/[.-]/).map((s) => Number.parseInt(s, 10) || 0);
  return [a, b, c];
}

function compareSemver(a: string, b: string): number {
  const x = semver(a);
  const y = semver(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Candidate build keys in probe order (see the header comment). */
export function buildCandidates(
  builds: readonly ProtomapsBuild[],
  majors: readonly number[] = COMPATIBLE_TILESET_MAJORS,
): ProtomapsBuild[] {
  const ok = builds.filter((b) => majors.includes(semver(b.version)[0]));
  const byKeyDesc = [...ok].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const out: ProtomapsBuild[] = [];
  const seen = new Set<string>();
  const add = (b: ProtomapsBuild | undefined) => {
    if (b && !seen.has(b.key)) {
      seen.add(b.key);
      out.push(b);
    }
  };
  add(byKeyDesc[0]);
  const versions = [...new Set(ok.map((b) => b.version))].sort((a, b) => compareSemver(b, a));
  for (const v of versions) {
    const first = ok.filter((b) => b.version === v).sort((a, b) => (a.key < b.key ? -1 : 1))[0];
    add(first);
  }
  return out;
}

export function buildUrl(key: string): string {
  return new URL(key, PROTOMAPS_BUILD_BASE).toString();
}

/** Is `bytes` the start of a PMTiles v3 archive? */
export function isPmtilesHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 7)).toString('latin1') === 'PMTiles' &&
    bytes[7] === 3
  );
}

/** Probe a remote archive: answers range requests with a PMTiles v3 header? */
export async function probeArchive(url: string, fetchImpl?: FetchLike): Promise<void> {
  const res = await fetchWithRetry(
    url,
    { headers: { range: 'bytes=0-126' } },
    { retries: 1, timeoutMs: 20_000, fetch: fetchImpl },
  );
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} (expected 206 to a range request)`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isPmtilesHeader(bytes)) throw new Error('not a PMTiles v3 archive');
}

export interface ResolvedBuild {
  build: ProtomapsBuild;
  url: string;
}

/** Fetch the listing and return the first reachable candidate. Throws with every attempt's reason. */
export async function resolveBuild(
  opts: { listingUrl?: string; fetch?: FetchLike; maxProbes?: number } = {},
): Promise<ResolvedBuild> {
  const listingUrl = opts.listingUrl ?? PROTOMAPS_BUILDS_URL;
  let json: unknown;
  try {
    const res = await fetchWithRetry(listingUrl, {}, { fetch: opts.fetch, timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    throw new Error(
      `could not read the Protomaps builds listing ${listingUrl}: ${describeError(e)}`,
    );
  }
  const candidates = buildCandidates(parseBuildsListing(json)).slice(0, opts.maxProbes ?? 6);
  if (candidates.length === 0) {
    throw new Error(
      `no build with tileset version ${COMPATIBLE_TILESET_MAJORS.join('/')}.x in ${listingUrl}`,
    );
  }
  const failures: string[] = [];
  for (const build of candidates) {
    const url = buildUrl(build.key);
    try {
      await probeArchive(url, opts.fetch);
      return { build, url };
    } catch (e) {
      failures.push(`${build.key} (${build.version}): ${describeError(e)}`);
    }
  }
  throw new Error(`no Protomaps build is reachable:\n  - ${failures.join('\n  - ')}`);
}
