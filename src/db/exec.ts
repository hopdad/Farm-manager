/**
 * Run one parameterized SQL statement on either a pg executor (Pool, PoolClient, Client) or a
 * Drizzle database / transaction, so shared helpers (leases, external refs) work from route
 * handlers (pg pool), sync steps (Drizzle `tx`) and the seed alike.
 *
 * `text` uses pg placeholders ($1, $2, …). Drizzle receives the same statement with the values
 * bound as parameters (never interpolated). Unnamed statements only (plan §1: no prepared names).
 */
import { type SQL, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db, DbTx, Queryable } from './client';

export type Executor = Queryable | Db | DbTx;

export interface ExecResult<R> {
  rows: R[];
  rowCount: number;
}

function isDrizzle(ex: Executor): ex is Db | DbTx {
  // Drizzle databases also have a `query` property (relational queries), so test `execute`.
  return typeof (ex as { execute?: unknown }).execute === 'function';
}

/** `text` with $n placeholders -> a Drizzle SQL object with bound parameters. */
export function toDrizzleSql(text: string, values: readonly unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) chunks.push(sql.raw(parts[i] as string));
    } else {
      const n = Number(parts[i]);
      if (n < 1 || n > values.length) throw new RangeError(`placeholder $${n} has no value`);
      // sql.param, not sql`${v}`: Drizzle expands a bare array into `(p1, p2, …)`, while pg
      // needs it as ONE array parameter (`= any($1::text[])`).
      chunks.push(sql`${sql.param(values[n - 1])}`);
    }
  }
  return sql.join(chunks);
}

export async function exec<R = Record<string, unknown>>(
  ex: Executor,
  text: string,
  values: readonly unknown[] = [],
): Promise<ExecResult<R>> {
  if (isDrizzle(ex)) {
    const r = (await ex.execute(toDrizzleSql(text, values))) as unknown as pg.QueryResult;
    return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
  }
  const r = await ex.query(text, values as unknown[]);
  return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
}

const parseTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ) as (
  v: string,
) => Date;

/**
 * A timestamptz from either driver path: pg returns Date; Drizzle's raw `execute` returns the
 * Postgres text form ('2026-10-29 12:00:00.123+00'), which `new Date()` can't parse reliably.
 */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return parseTimestamptz(v);
  throw new TypeError(`not a timestamp: ${String(v)}`);
}
