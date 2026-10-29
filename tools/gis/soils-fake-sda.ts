/**
 * A fake Soil Data Access for tests and for building the synthetic fixture (owner: soils). It
 * answers the five query shapes ./soils-sql.ts builds, over in-memory SSURGO-like tables, in the
 * documented JSON+COLUMNNAME shape (./soils-sda.ts): values as strings, `{}` for no rows,
 * HTTP 500 + XML <ServiceException> for errors. Anything else is a 400 ServiceException, so a
 * query the real code sends that the fake doesn't recognise fails loudly.
 *
 * Fault knobs reproduce what the plan warns about (§5 "an empty reply can mean you hit one"):
 *  - `silentRowLimit`: a polygon reply with more rows than this comes back as `{}` (silently
 *    empty; the real limits are far above any catalogue, map unit or component reply);
 *  - `failInListOver`: a polygon request naming more map units than this fails (500);
 *  - `maintenance`: every request gets the non-JSON maintenance page.
 * Never used by `pnpm gis:soils` itself.
 */
import type { FetchLike } from './http';
import { NCCPI_RULE } from './soils-sql';

export interface FakeSdaDatabase {
  sacatalog: { areasymbol: string; areaname: string; saverest: string }[];
  mapunit: {
    mukey: string;
    areasymbol: string;
    musym: string;
    muname: string;
    farmlndcl: string | null;
  }[];
  component: {
    mukey: string;
    cokey: string;
    compname: string;
    comppct_r: number;
    majcompflag: 'Yes' | 'No';
    compkind: string;
    drainagecl: string | null;
    hydgrp: string | null;
    /** cointerp interphr for NCCPI_RULE at ruledepth 0 (null = no row). */
    nccpi: number | null;
  }[];
  mupolygon: { mupolygonkey: string; mukey: string; wkt: string }[];
}

export interface FakeSdaOptions {
  silentRowLimit?: number;
  failInListOver?: number;
  maintenance?: boolean;
}

export interface FakeSda {
  fetch: FetchLike;
  /** Every query received, in order. */
  queries: string[];
  options: FakeSdaOptions;
}

type Cell = string | null;

const keyCmp = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const s = (v: number | string | null): Cell => (v === null ? null : String(v));

function inListOf(q: string, column: string): string[] | null {
  const re = new RegExp(`${column.replace('.', '\\.')} IN \\(([^)]*)\\)`);
  const m = re.exec(q);
  if (!m?.[1]) return null;
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
}

/** Vertex count of a WKT polygon / multipolygon (coordinate pairs). */
export function wktVertices(wkt: string): number {
  return (wkt.match(/-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/g) ?? []).length;
}

function execute(db: FakeSdaDatabase, q: string): { columns: string[]; rows: Cell[][] } | null {
  if (/FROM sacatalog/.test(q)) {
    const areas = inListOf(q, 'sc.areasymbol') ?? [];
    return {
      columns: ['areasymbol', 'areaname', 'saverest'],
      rows: db.sacatalog
        .filter((r) => areas.includes(r.areasymbol))
        .sort((a, b) => a.areasymbol.localeCompare(b.areasymbol))
        .map((r) => [r.areasymbol, r.areaname, r.saverest]),
    };
  }
  if (/GROUP BY mu\.mukey/.test(q)) {
    const area = /l\.areasymbol = '([A-Z0-9]+)'/.exec(q)?.[1];
    return {
      columns: ['mukey', 'musym', 'muname', 'farmlndcl', 'polygons', 'vertices'],
      rows: db.mapunit
        .filter((m) => m.areasymbol === area)
        .sort((a, b) => keyCmp(a.mukey, b.mukey))
        .map((m) => {
          const polys = db.mupolygon.filter((p) => p.mukey === m.mukey);
          const vertices = polys.reduce((n, p) => n + wktVertices(p.wkt), 0);
          return [
            m.mukey,
            m.musym,
            m.muname,
            m.farmlndcl,
            s(polys.length),
            polys.length ? s(vertices) : null,
          ];
        }),
    };
  }
  if (/FROM component AS c/.test(q)) {
    if (!q.includes(NCCPI_RULE)) return null;
    const mukeys = inListOf(q, 'c.mukey') ?? [];
    return {
      columns: [
        'mukey',
        'cokey',
        'compname',
        'comppct_r',
        'majcompflag',
        'compkind',
        'drainagecl',
        'hydgrp',
        'nccpi',
      ],
      rows: db.component
        .filter((c) => mukeys.includes(c.mukey))
        .sort(
          (a, b) =>
            keyCmp(a.mukey, b.mukey) || b.comppct_r - a.comppct_r || keyCmp(a.cokey, b.cokey),
        )
        .map((c) => [
          c.mukey,
          c.cokey,
          c.compname,
          s(c.comppct_r),
          c.majcompflag,
          c.compkind,
          c.drainagecl,
          c.hydgrp,
          s(c.nccpi),
        ]),
    };
  }
  const page =
    /^SELECT TOP (\d+) p\.mupolygonkey[\s\S]*p\.mukey = '(\d+)' AND p\.mupolygonkey > (\d+)/.exec(
      q,
    );
  if (page?.[1] && page[2] && page[3]) {
    const [top, mukey, after] = [Number(page[1]), page[2], page[3]];
    return {
      columns: ['mupolygonkey', 'mukey', 'wkt'],
      rows: db.mupolygon
        .filter((p) => p.mukey === mukey && keyCmp(p.mupolygonkey, after) > 0)
        .sort((a, b) => keyCmp(a.mupolygonkey, b.mupolygonkey))
        .slice(0, top)
        .map((p) => [p.mupolygonkey, p.mukey, p.wkt]),
    };
  }
  if (/FROM mupolygon AS p/.test(q)) {
    const mukeys = inListOf(q, 'p.mukey');
    if (!mukeys) return null;
    return {
      columns: ['mupolygonkey', 'mukey', 'wkt'],
      rows: db.mupolygon
        .filter((p) => mukeys.includes(p.mukey))
        .sort((a, b) => keyCmp(a.mupolygonkey, b.mupolygonkey))
        .map((p) => [p.mupolygonkey, p.mukey, p.wkt]),
    };
  }
  return null;
}

const serviceError = (status: number, msg: string) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><ServiceExceptionReport><ServiceException>${msg}</ServiceException></ServiceExceptionReport>`,
    { status, headers: { 'content-type': 'text/xml; charset=utf-8' } },
  );

export function createFakeSda(db: FakeSdaDatabase, options: FakeSdaOptions = {}): FakeSda {
  const queries: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if (options.maintenance) {
      return new Response(
        '<html><body>Site is under daily maintenance from 12:30 AM CST to 12:45 AM CST. Please try after 12:45 AM CST.</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    let body: { query?: unknown; format?: unknown };
    try {
      body = JSON.parse(String(init?.body ?? ''));
    } catch {
      return serviceError(400, 'Request body is not JSON');
    }
    if (body.format !== 'JSON+COLUMNNAME' || typeof body.query !== 'string') {
      return serviceError(400, 'Expected {format: JSON+COLUMNNAME, query}');
    }
    const q = body.query;
    queries.push(q);
    if (options.failInListOver !== undefined && /FROM mupolygon AS p/.test(q)) {
      const n = inListOf(q, 'p.mukey')?.length ?? 0;
      if (n > options.failInListOver) {
        return serviceError(500, 'Query exceeded the maximum allowed response size.');
      }
    }
    const result = execute(db, q);
    if (!result) return serviceError(400, 'Invalid query: not recognised by the fake SDA');
    if (result.rows.length === 0) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (
      options.silentRowLimit !== undefined &&
      /FROM mupolygon AS p/.test(q) &&
      result.rows.length > options.silentRowLimit
    ) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ Table: [result.columns, ...result.rows] }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return { fetch, queries, options };
}
