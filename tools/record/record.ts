/**
 * `pnpm connectors:record <source> [--scrub] [--out <dir>] [--raw <dir>]` (1f decision 3,
 * docs/contracts-1f.md §8 and §9; owner: sync-health): run the live client of <source> (deere,
 * samsara) in its configured mode through a recording `fetch`, endpoint by endpoint
 * (./plans.ts), and keep what came back:
 *
 *  - RAW responses only under data/raw/recorded/<source>/<stream>/ (gitignored; `--raw <dir>`
 *    elsewhere): method, URL, status and body, never a request header (no token is ever written)
 *    and never an OAuth exchange (authorize, token);
 *  - with `--scrub`, an anonymized copy per stream as a recorded replay fixture (./scrub.ts: ids
 *    hashed, names pseudonymized, coordinates moved into the demo area, secrets dropped) under
 *    src/connectors/<source>/fixtures/recorded/<stream>/ (or `--out <dir>/<stream>/`), each
 *    exchange validated by the live zod schema of its endpoint and the whole file by
 *    `replayFixtureSchema`, and refused if any original id or name survives.
 *
 * An endpoint the stand-in answers 404 "not simulated" is skipped and listed (a run against sim
 * records what the stand-in serves). Replay and off are refused: there is nothing to record.
 * In 1f nothing recorded is committed (§8): the recorded lists stay empty and the board keeps the
 * doc-derived fixtures; a scrubbed recording from Derrick's PC joins `<source>RecordedFixtures`,
 * which only the contract and conformance tests read.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeereClient } from '../../src/connectors/deere/client';
import {
  type ConnectorConfig,
  deereEndpoints,
  samsaraEndpoint,
} from '../../src/connectors/endpoints';
import { VendorHttpError } from '../../src/connectors/http';
import { MemoryTokenStore } from '../../src/connectors/oauth/memory-store';
import type { TokenStore } from '../../src/connectors/oauth/token-store';
import {
  type ReplayExchange,
  type ReplayFixture,
  replayFixtureSchema,
} from '../../src/connectors/replay';
import { SamsaraClient } from '../../src/connectors/samsara/client';
import type { Mode } from '../../src/connectors/types';
import {
  DEFAULT_LIMITS,
  deerePlan,
  type PlanLimits,
  type PlanStep,
  type RecordSource,
  samsaraPlan,
} from './plans';
import { createScrubber } from './scrub';

/** One recorded exchange (raw). */
export interface RecordedExchange {
  stream: string;
  name: string;
  method: string;
  url: string;
  status: number;
  contentType: string | null;
  /** Parsed JSON, or the text when it isn't JSON. */
  body: unknown;
}

export interface RecordOptions {
  source: RecordSource;
  mode: Mode;
  cfg: ConnectorConfig;
  /** Deere's token store (the PC: OAuthTokenStore; tests: a MemoryTokenStore; sim connects itself). */
  tokens?: TokenStore;
  scrub: boolean;
  /** Scrubbed fixtures go to `<outDir>/<stream>/` (default src/connectors/<source>/fixtures/recorded). */
  outDir?: string | null;
  /** Raw responses go to `<rawDir>/<stream>/` (default data/raw/recorded/<source>). */
  rawDir?: string;
  /** Project root for the defaults (default: the working directory). */
  projectDir?: string;
  now?: () => Date;
  /** Hash salt (default random per run: hashes are stable within a run). */
  salt?: string;
  limits?: PlanLimits;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface RecordReport {
  source: RecordSource;
  mode: Mode;
  recordedAt: string;
  exchanges: number;
  rawFiles: string[];
  fixtureFiles: string[];
  /** Endpoints the stand-in answered 404 "not simulated". */
  skipped: { stream: string; name: string; path: string }[];
  /** Endpoints that failed otherwise (kept in raw, never in a fixture). */
  failed: { stream: string; name: string; error: string }[];
  /** Scrubbed files that failed validation or kept an original id or name (nothing written). */
  scrubErrors: string[];
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

/** OAuth exchanges are never recorded (codes, tokens). */
function isOAuthUrl(u: URL): boolean {
  return /\/oauth2\/|\/oauth\/|\/v1\/token$|\/v1\/authorize$/.test(u.pathname);
}

/** Query parameters that only window or size a request (dropped from fixture matching). */
const VOLATILE_QUERY = new Set(['startDate', 'endDate', 'startTime', 'endTime', 'itemLimit']);

const notSimulated = (e: unknown): e is VendorHttpError =>
  e instanceof VendorHttpError && e.status === 404 && /not simulated/i.test(e.detail ?? '');

export async function recordSource(opts: RecordOptions): Promise<RecordReport> {
  if (opts.mode === 'replay' || opts.mode === 'off') {
    throw new RecordError(
      `connectors:record ${opts.source}: nothing to record in ${opts.mode} mode (use sim, sandbox or live)`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const projectDir = opts.projectDir ?? process.cwd();
  const recordedAt = now().toISOString();
  const report: RecordReport = {
    source: opts.source,
    mode: opts.mode,
    recordedAt,
    exchanges: 0,
    rawFiles: [],
    fixtureFiles: [],
    skipped: [],
    failed: [],
    scrubErrors: [],
  };

  // ---- record -------------------------------------------------------------------------------
  const inner = opts.fetch ?? fetch;
  const recorded: RecordedExchange[] = [];
  let current: PlanStep | null = null;
  const schemas = new Map<string, PlanStep['schema']>();
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!current || isOAuthUrl(url)) return res;
    const text = await res.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
    recorded.push({
      stream: current.stream,
      name: current.name,
      method: (init?.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get('content-type'),
      body,
    });
    return res;
  };
  const http = { fetch: recordingFetch, now, timeoutMs: 30_000, maxRetries: 1 };
  const step = async <T>(s: PlanStep, fn: () => Promise<T>): Promise<T | null> => {
    current = s;
    schemas.set(`${s.stream}/${s.name}`, s.schema);
    const from = recorded.length;
    try {
      return await fn();
    } catch (e) {
      if (notSimulated(e)) {
        recorded.splice(from); // the stand-in's 404 is not a vendor shape
        report.skipped.push({ stream: s.stream, name: s.name, path: e.path });
        log(`skipped ${s.stream}/${s.name}: ${e.path} is not simulated`);
      } else {
        report.failed.push({ stream: s.stream, name: s.name, error: (e as Error).message });
        log(`failed ${s.stream}/${s.name}: ${(e as Error).message}`);
      }
      return null;
    } finally {
      current = null;
    }
  };

  let relPath: (u: URL) => string;
  let basePath: string | undefined;
  if (opts.source === 'deere') {
    const ep = deereEndpoints(opts.mode, opts.cfg);
    const client = new DeereClient({
      endpoints: ep,
      tokens: opts.tokens ?? new MemoryTokenStore('deere'),
      http,
    });
    const api = new URL(ep.apiBase);
    const equipment = new URL(ep.equipmentBase);
    basePath = '/platform';
    relPath = (u) =>
      u.origin === equipment.origin && u.pathname.startsWith(equipment.pathname)
        ? `/isg${u.pathname.slice(equipment.pathname.length)}`
        : u.pathname.startsWith(api.pathname)
          ? u.pathname.slice(api.pathname.length) || '/'
          : u.pathname;
    await deerePlan(client, step, now(), opts.limits ?? DEFAULT_LIMITS);
  } else {
    const ep = samsaraEndpoint(opts.mode, opts.cfg);
    const client = new SamsaraClient(ep, http);
    const base = new URL(ep.baseUrl);
    relPath = (u) =>
      base.pathname !== '/' && u.pathname.startsWith(base.pathname)
        ? u.pathname.slice(base.pathname.length)
        : u.pathname;
    await samsaraPlan(client, step);
  }
  report.exchanges = recorded.length;

  // ---- raw (local only) -----------------------------------------------------------------------
  const byStream = new Map<string, RecordedExchange[]>();
  for (const x of recorded) byStream.set(x.stream, [...(byStream.get(x.stream) ?? []), x]);
  const rawDir = opts.rawDir ?? path.join(projectDir, 'data', 'raw', 'recorded', opts.source);
  for (const [stream, exchanges] of byStream) {
    const file = path.join(rawDir, stream, `01-${stream}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ source: opts.source, mode: opts.mode, stream, recordedAt, exchanges }, null, 2)}\n`,
    );
    report.rawFiles.push(file);
  }

  if (!opts.scrub) return report;

  // ---- scrubbed fixtures --------------------------------------------------------------------
  const scrubber = createScrubber({ salt: opts.salt ?? randomBytes(16).toString('hex') });
  for (const x of recorded) {
    scrubber.observeUrl(new URL(x.url));
    scrubber.observe(x.body);
  }
  const outDir =
    opts.outDir ?? path.join(projectDir, 'src', 'connectors', opts.source, 'fixtures', 'recorded');
  for (const [stream, exchanges] of byStream) {
    const errors: string[] = [];
    const seen = new Set<string>();
    const out: ReplayExchange[] = [];
    for (const x of exchanges) {
      // Errors other than refusals the app handles (403) aren't vendor shapes worth replaying.
      if (x.status >= 500 || (x.status >= 400 && x.status !== 403)) continue;
      if (typeof x.body !== 'object' || x.body === null) continue;
      const u = new URL(x.url);
      const params = new URLSearchParams();
      for (const [k, v] of u.searchParams) if (!VOLATILE_QUERY.has(k)) params.append(k, v);
      const query = scrubber.scrubQuery(params);
      const request: ReplayExchange['request'] = {
        method: x.method === 'POST' ? 'POST' : 'GET',
        path: scrubber.scrubPath(relPath(u)),
        ...(Object.keys(query).length ? { query } : {}),
      };
      const key = JSON.stringify(request);
      if (seen.has(key)) continue;
      seen.add(key);
      const body = scrubber.scrub(x.body);
      if (x.status < 300) {
        const schema = schemas.get(`${x.stream}/${x.name}`);
        const r = schema?.safeParse(body);
        if (r && !r.success) {
          const i = r.error.issues[0];
          errors.push(
            `${stream}/${x.name} ${request.path}: fails the live schema (${i?.path.join('.') ?? ''}: ${i?.message ?? ''})`,
          );
        }
      }
      out.push({ request, response: { status: x.status, body } });
    }
    if (out.length === 0) continue;
    // A later page (more query keys, e.g. pageOffset / after) before the first page.
    out.sort(
      (a, b) =>
        Object.keys(b.request.query ?? {}).length - Object.keys(a.request.query ?? {}).length,
    );
    const fixture: ReplayFixture = {
      format: 1,
      source: opts.source,
      stream,
      kind: 'recorded',
      reference: `connectors:record ${recordedAt.slice(0, 10)} (${opts.mode}), scrubbed: ids hashed, names pseudonymized, coordinates moved into the demo area, no tokens; no real farm data`,
      anchor: recordedAt,
      ...(basePath ? { basePath } : {}),
      exchanges: out,
    };
    const parsed = replayFixtureSchema.safeParse(fixture);
    if (!parsed.success)
      errors.push(`${stream}: not a valid replay fixture (${parsed.error.message})`);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    const left = scrubber.survivors(text);
    if (left.length) {
      errors.push(`${stream}: ${left.length} original id(s) or name(s) survived scrubbing`);
    }
    if (errors.length) {
      report.scrubErrors.push(...errors);
      continue;
    }
    const file = path.join(outDir, stream, `01-${stream}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    report.fixtureFiles.push(file);
  }
  return report;
}

/** The report as lines for the terminal. */
export function formatReport(r: RecordReport): string {
  const lines = [
    `connectors:record ${r.source} (${r.mode}) at ${r.recordedAt}: ${r.exchanges} exchanges`,
    ...r.rawFiles.map((f) => `  raw      ${f}`),
    ...r.fixtureFiles.map((f) => `  scrubbed ${f}`),
    ...r.skipped.map((s) => `  skipped  ${s.stream}/${s.name}: ${s.path} (not simulated)`),
    ...r.failed.map((s) => `  failed   ${s.stream}/${s.name}: ${s.error}`),
    ...r.scrubErrors.map((e) => `  REFUSED  ${e}`),
  ];
  return lines.join('\n');
}
