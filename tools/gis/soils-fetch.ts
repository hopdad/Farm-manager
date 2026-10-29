/**
 * Download phase of `pnpm gis:soils`: Soil Data Access → one run directory under
 * data/raw/soils (./soils-raw.ts). Owner: soils. No database access: the load phase
 * (./soils-load.ts) reads the run, so a live load and an offline rebuild run the same code.
 *
 * Per survey area (MI091 Lenawee, MI115 Monroe; plan §5, county-wide):
 *   1. the catalogue rows of all areas (survey version dates)        → survey.json
 *   2. map units with polygon and vertex counts                      → <AREA>.stats.json
 *   3. components (+ NCCPI from cointerp) in mukey batches           → <AREA>.components.NNN.json
 *   4. polygons (WKT) in planned mukey batches; a map unit too big
 *      for one reply pages on mupolygonkey                           → <AREA>.polygons.NNN.json
 * A polygon reply with fewer rows than counted, an error, or a reply at SDA's row limit is not
 * kept: the batch is split (./soils-plan.ts splitTask) and retried. Expected counts come from
 * step 2; a paged map unit stops at its first short page.
 */
import { rm } from 'node:fs/promises';
import { toMapunitStatsRows, toPolygonRows } from './soils-model';
import {
  type BatchLimits,
  chunkKeys,
  DEFAULT_LIMITS,
  type MukeySize,
  type PolygonTask,
  planPolygonTasks,
  splitTask,
} from './soils-plan';
import {
  manifestPath,
  newRunDir,
  type RunFile,
  type RunFileKind,
  type RunIndex,
  SOILS_RAW_SOURCE,
  SSURGO_LICENCE,
  sha256Hex,
  upsertManifestEntries,
  writeRunFile,
  writeRunIndex,
} from './soils-raw';
import {
  SDA_FORMAT,
  SDA_MAX_ROWS,
  SDA_POST_URL,
  type SdaClientOptions,
  SdaError,
  type SdaReply,
  sdaQuery,
  sdaRecords,
} from './soils-sda';
import {
  areaSymbol,
  componentsSql,
  mapunitStatsSql,
  NCCPI_RULE,
  polygonPageSql,
  polygonsSql,
  surveyAreasSql,
} from './soils-sql';

export interface FetchOptions {
  areas: readonly string[];
  /** data/raw. */
  rawRoot: string;
  client?: SdaClientOptions;
  limits?: BatchLimits;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Marks the run as a synthetic fixture (run.json `fixture`); only the fixture builder sets it. */
  fixtureNote?: string;
}

export interface FetchResult {
  dir: string;
  index: RunIndex;
  /** Polygon requests that had to be split. */
  splits: number;
}

/** Errors worth splitting a polygon batch for (anything SDA itself refused or broke on). */
function splittable(e: unknown): boolean {
  return (
    e instanceof SdaError &&
    (e.kind === 'service' ||
      e.kind === 'http' ||
      e.kind === 'parse' ||
      e.kind === 'network' ||
      e.kind === 'query_too_long')
  );
}

export async function fetchSoilsRun(opts: FetchOptions): Promise<FetchResult> {
  const areas = [...new Set(opts.areas.map(areaSymbol))].sort();
  if (areas.length === 0) throw new Error('no survey areas to download');
  const now = opts.now ?? (() => new Date());
  const dir = await newRunDir(opts.rawRoot, now());
  try {
    return await fetchInto(dir, areas, opts, now);
  } catch (e) {
    // A run without run.json is never loaded; don't leave half a download behind either.
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function fetchInto(
  dir: string,
  areas: string[],
  opts: FetchOptions,
  now: () => Date,
): Promise<FetchResult> {
  const log = opts.log ?? (() => {});
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const url = opts.client?.url ?? SDA_POST_URL;
  const startedAt = now().toISOString();
  const files: RunFile[] = [];
  let splits = 0;

  const keep = async (
    file: string,
    kind: RunFileKind,
    area: string | null,
    query: string,
    reply: SdaReply,
  ): Promise<void> => {
    const { sha256, bytes } = await writeRunFile(dir, file, reply.text);
    files.push({
      file,
      kind,
      area,
      query,
      rows: reply.table.rows.length,
      bytes,
      sha256,
      fetchedAt: now().toISOString(),
    });
  };
  const ask = (query: string) => sdaQuery(query, opts.client);

  // 1. Catalogue.
  {
    const q = surveyAreasSql(areas);
    const reply = await ask(q);
    const found = new Set(sdaRecords(reply.table).map((r) => String(r.areasymbol).toUpperCase()));
    const missing = areas.filter((a) => !found.has(a));
    if (missing.length) throw new Error(`SDA has no survey area ${missing.join(', ')}`);
    await keep('survey.json', 'survey', null, q, reply);
  }

  for (const area of areas) {
    // 2. Map units with sizes.
    const statsQuery = mapunitStatsSql(area);
    const statsReply = await ask(statsQuery);
    const stats = toMapunitStatsRows(sdaRecords(statsReply.table));
    if (stats.length === 0) throw new Error(`SDA returned no map units for ${area}`);
    if (statsReply.table.rows.length >= SDA_MAX_ROWS) {
      throw new Error(`${area}: the map unit list hit SDA's ${SDA_MAX_ROWS}-row limit`);
    }
    await keep(`${area}.stats.json`, 'stats', area, statsQuery, statsReply);
    const totalPolygons = stats.reduce((n, s) => n + s.polygons, 0);
    log(`${area}: ${stats.length} map units, ${totalPolygons} polygons`);

    // 3. Components.
    let n = 0;
    for (const batch of chunkKeys(
      stats.map((s) => s.mukey),
      limits.componentMukeys,
    )) {
      const q = componentsSql(batch);
      const reply = await ask(q);
      if (reply.table.rows.length >= SDA_MAX_ROWS) {
        throw new Error(`${area}: a component batch hit SDA's row limit; lower componentMukeys`);
      }
      n++;
      await keep(
        `${area}.components.${String(n).padStart(3, '0')}.json`,
        'components',
        area,
        q,
        reply,
      );
    }

    // 4. Polygons.
    const sizes = new Map<string, MukeySize>(stats.map((s) => [s.mukey, s]));
    const queue: PolygonTask[] = planPolygonTasks(stats, limits);
    let fileNo = 0;
    let got = 0;
    const nextFile = () => `${area}.polygons.${String(++fileNo).padStart(3, '0')}.json`;
    while (queue.length > 0) {
      const task = queue.shift() as PolygonTask;
      if (task.kind === 'mukeys') {
        const q = polygonsSql(task.mukeys);
        let reply: SdaReply | null = null;
        let problem: string | null = null;
        try {
          reply = await ask(q);
          const rows = reply.table.rows.length;
          if (rows < task.polygons) problem = `${rows} of ${task.polygons} polygons`;
          else if (rows >= SDA_MAX_ROWS) problem = `${rows} rows (at SDA's limit)`;
        } catch (e) {
          if (!splittable(e)) throw e;
          problem = (e as Error).message;
        }
        if (problem === null && reply) {
          await keep(nextFile(), 'polygons', area, q, reply);
          got += reply.table.rows.length;
          continue;
        }
        const smaller = splitTask(task, sizes);
        if (!smaller) throw new Error(`${area}: cannot split polygon request further (${problem})`);
        splits++;
        log(`${area}: ${task.mukeys.length} map unit(s) came back short (${problem}); splitting`);
        queue.unshift(...smaller);
        continue;
      }

      // Paged map unit: keyset pages until a short page.
      let after = '0';
      let pageSize = task.pageSize;
      let seen = 0;
      for (;;) {
        const q = polygonPageSql(task.mukey, after, pageSize);
        let reply: SdaReply;
        try {
          reply = await ask(q);
        } catch (e) {
          if (!splittable(e) || pageSize <= 1) throw e;
          splits++;
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          log(
            `${area}: map unit ${task.mukey} page failed (${(e as Error).message}); page size ${pageSize}`,
          );
          continue;
        }
        const rows = toPolygonRows(sdaRecords(reply.table));
        const short = rows.length < pageSize;
        if (short && seen + rows.length < task.polygons && pageSize > 1) {
          // Short before the counted total: maybe a silent limit. Same page, smaller.
          splits++;
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          log(`${area}: map unit ${task.mukey} page came back short; page size ${pageSize}`);
          continue;
        }
        if (rows.length > 0) {
          await keep(nextFile(), 'polygons', area, q, reply);
          seen += rows.length;
          after = rows[rows.length - 1]?.mupolygonkey ?? after;
        }
        if (short) break;
      }
      if (seen < task.polygons) {
        log(
          `${area}: map unit ${task.mukey} has ${seen} polygons (counted ${task.polygons}); kept them`,
        );
      }
      got += seen;
    }
    log(`${area}: ${got} polygons in ${fileNo} file(s)`);
  }

  const index: RunIndex = {
    format: 1,
    source: SOILS_RAW_SOURCE,
    service: url,
    requestFormat: SDA_FORMAT,
    nccpiRule: NCCPI_RULE,
    areas,
    startedAt,
    finishedAt: now().toISOString(),
    complete: true,
    ...(opts.fixtureNote ? { fixture: opts.fixtureNote } : {}),
    files,
  };
  await upsertManifestEntries(
    opts.rawRoot,
    files.map((f) => ({
      source: SOILS_RAW_SOURCE,
      path: manifestPath(opts.rawRoot, dir, f.file),
      url,
      method: 'POST' as const,
      requestSha256: sha256Hex(JSON.stringify({ format: SDA_FORMAT, query: f.query })),
      fetchedAt: f.fetchedAt,
      sha256: f.sha256,
      bytes: f.bytes,
      licence: SSURGO_LICENCE,
    })),
  );
  // Last: the run exists only once its index does.
  await writeRunIndex(dir, index);
  return { dir, index, splits };
}
