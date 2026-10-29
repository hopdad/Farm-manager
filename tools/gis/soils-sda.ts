/**
 * NRCS Soil Data Access (SDA) client for `pnpm gis:soils` (plan §5 "Soils (SSURGO)"). Owner: soils.
 *
 * The service takes one T-SQL SELECT per request and answers JSON:
 *
 *   POST https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest
 *   Content-Type: application/json
 *   {"format": "JSON+COLUMNNAME", "query": "SELECT …"}
 *   →  {"Table": [["col1", "col2", …], ["v1", "v2", …], …]}     (values are strings or null)
 *   →  {}                                                          (no rows)
 *
 * Sources (checked Oct 29, 2026; SDA itself answers 403 at the build machine's proxy, so the
 * request and reply shapes come from NRCS's own clients and help page, not from a live call):
 *  - SDA Web Service Help, https://sdmdataaccess.nrcs.usda.gov/WebServiceHelp.aspx: FORMAT is
 *    XML (default), JSON, JSON+COLUMNNAME or JSON+COLUMNNAME+METADATA; with JSON+COLUMNNAME the
 *    first row holds the column names and the data starts on the second.
 *  - NRCS soilDB `SDA_query()`, https://github.com/ncss-tech/soilDB/blob/master/R/SDA_query.R:
 *    "There is a 100,000 record and 32Mb JSON serialization limit per query … iterate over
 *    logical chunks (e.g. areasymbol, mukey, cokey)"; queries over 2.5 million bytes are refused;
 *    errors come back as HTTP >= 400 with an XML <ServiceException>; during the daily maintenance
 *    window (12:30-12:45 AM CST) the reply is not JSON; an empty result set is `{}`.
 *  - NRCS pysda, https://github.com/ncss-tech/pysda (sdapoly.py, sdainterp.py): the JSON request
 *    body above and `results.json()['Table'][0]` as the column names.
 *
 * Hitting a limit does not always produce an error: a reply can come back empty or short (plan
 * §5). The fetch step (./soils-fetch.ts) therefore compares row counts with what it expected and
 * splits the request when they disagree.
 */
import { describeError, type FetchLike, fetchWithRetry } from './http';

/** The documented endpoint (plan §5). */
export const SDA_POST_URL = 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest';
export const SDA_FORMAT = 'JSON+COLUMNNAME';
/** Per-query limits (soilDB SDA_query docs). */
export const SDA_MAX_ROWS = 100_000;
export const SDA_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const SDA_MAX_QUERY_BYTES = 2_500_000;
/** Who is asking (SDA logs it; NRCS asks heavy users to identify themselves). */
export const SDA_USER_AGENT = 'farm-manager gis:soils (Node.js)';

export type SdaCell = string | number | boolean | null;

export interface SdaTable {
  /** Column names as SDA returned them. */
  columns: string[];
  rows: SdaCell[][];
}

export type SdaErrorKind =
  /** HTTP error without a ServiceException body. */
  | 'http'
  /** SDA refused or failed the query (ServiceException), e.g. invalid SQL or a limit. */
  | 'service'
  /** Not JSON: the maintenance page, a proxy page, an outage. */
  | 'unavailable'
  /** JSON, but not the documented shape. */
  | 'parse'
  /** The query is over SDA_MAX_QUERY_BYTES (never sent). */
  | 'query_too_long'
  /** Network failure or timeout after the retries. */
  | 'network';

export class SdaError extends Error {
  constructor(
    readonly kind: SdaErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'SdaError';
  }
}

/** Parse a JSON+COLUMNNAME reply. `{}` (no rows) is an empty table. Throws SdaError('parse'). */
export function parseSdaBody(text: string): SdaTable {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SdaError('unavailable', `SDA reply is not JSON: ${snippet(text)}`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SdaError('parse', `SDA reply is not a JSON object: ${snippet(text)}`);
  }
  const keys = Object.keys(body);
  if (keys.length === 0) return { columns: [], rows: [] };
  if (keys.length > 1 || keys[0] !== 'Table') {
    throw new SdaError('parse', `SDA reply has tables ${keys.join(', ')}; expected one 'Table'`);
  }
  const table = (body as { Table: unknown }).Table;
  if (!Array.isArray(table) || table.length === 0 || !table.every(Array.isArray)) {
    throw new SdaError('parse', 'SDA reply: Table is not a non-empty array of rows');
  }
  const [head, ...rows] = table as unknown[][];
  if (!head?.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new SdaError('parse', 'SDA reply: the first row is not the column names');
  }
  const columns = head as string[];
  rows.forEach((r, i) => {
    if (r.length !== columns.length) {
      throw new SdaError(
        'parse',
        `SDA reply: row ${i + 1} has ${r.length} values for ${columns.length} columns`,
      );
    }
    for (const v of r) {
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
        throw new SdaError('parse', `SDA reply: row ${i + 1} has a non-scalar value`);
      }
    }
  });
  return { columns, rows: rows as SdaCell[][] };
}

/** Rows as objects keyed by lower-case column name. */
export function sdaRecords(table: SdaTable): Record<string, SdaCell>[] {
  const names = table.columns.map((c) => c.toLowerCase());
  return table.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? null])));
}

/** The ServiceException text of an SDA error page, if any. */
export function serviceExceptionOf(text: string): string | null {
  const m = /<ServiceException(?:\s[^>]*)?>([\s\S]*?)<\/ServiceException>/i.exec(text);
  if (!m?.[1]) return null;
  return m[1]
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;|&#60;/g, '<')
    .replace(/&gt;|&#62;/g, '>')
    .replace(/&amp;|&#38;/g, '&')
    .trim();
}

function snippet(text: string, max = 160): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s || '(empty)';
}

export interface SdaClientOptions {
  /** Default SDA_POST_URL. */
  url?: string;
  /** Default global fetch (tests pass a fake SDA). */
  fetch?: FetchLike;
  /** Per attempt. Default 180 s (big polygon batches take a while). */
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx. Default 3. */
  retries?: number;
  backoffMs?: number;
}

export interface SdaReply {
  /** The body exactly as received (cached under data/raw verbatim). */
  text: string;
  bytes: number;
  table: SdaTable;
}

/** Run one query. Throws SdaError. */
export async function sdaQuery(query: string, opts: SdaClientOptions = {}): Promise<SdaReply> {
  const queryBytes = Buffer.byteLength(query, 'utf8');
  if (queryBytes > SDA_MAX_QUERY_BYTES) {
    throw new SdaError(
      'query_too_long',
      `SDA query is ${queryBytes} bytes (limit ${SDA_MAX_QUERY_BYTES}): use smaller batches`,
    );
  }
  const url = opts.url ?? SDA_POST_URL;
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': SDA_USER_AGENT,
        },
        body: JSON.stringify({ format: SDA_FORMAT, query }),
      },
      {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs ?? 180_000,
        retries: opts.retries ?? 3,
        backoffMs: opts.backoffMs,
      },
    );
  } catch (e) {
    // fetchWithRetry words its error for GETs; say POST and keep the cause.
    const reason = describeError(e).replace(/^GET \S+ failed: /, '');
    throw new SdaError('network', `POST ${url} failed: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const service = serviceExceptionOf(text);
    if (service) throw new SdaError('service', `SDA: ${service}`, res.status);
    if (/daily maintenance/i.test(text)) {
      throw new SdaError(
        'unavailable',
        'SDA is in its daily maintenance window (12:30-12:45 AM CST); try again in 15 minutes',
        res.status,
      );
    }
    throw new SdaError('http', `POST ${url} → HTTP ${res.status}: ${snippet(text)}`, res.status);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!/json/i.test(contentType) && !/^\s*[{[]/.test(text)) {
    throw new SdaError(
      'unavailable',
      `SDA answered ${contentType || 'no content type'}, not JSON: ${snippet(text)}`,
      res.status,
    );
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8'), table: parseSdaBody(text) };
}
