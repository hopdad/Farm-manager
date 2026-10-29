/**
 * `tstzrange` columns as `{ from, to }` (half-open `[from, to)`, null = unbounded).
 * Used by farm.field_boundaries.valid (one current boundary per field, enforced by an
 * EXCLUDE constraint over (field_id, valid)).
 */
import { type SQL, sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

export interface TstzRange {
  /** Inclusive lower bound; null = -infinity. */
  from: Date | null;
  /** Exclusive upper bound; null = +infinity (still current). */
  to: Date | null;
}

/** SQL for `[from, to)`. */
export function tstzRange(range: TstzRange): SQL {
  const from = range.from ? range.from.toISOString() : null;
  const to = range.to ? range.to.toISOString() : null;
  return sql`tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`;
}

function parseBound(raw: string): Date | null {
  const v = raw.trim().replace(/^"|"$/g, '');
  if (v === '' || v === 'infinity' || v === '-infinity') return null;
  // Postgres prints "2026-10-28 23:54:29.552+00"; make it ISO-parseable.
  const iso = v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot parse tstzrange bound '${raw}'`);
  return d;
}

/** Parse Postgres range text such as `["2026-10-28 23:54:29+00",)`. Bounds are normalized to [from, to). */
export function parseTstzRange(text: string): TstzRange {
  if (text === 'empty') throw new Error('empty tstzrange');
  const m = /^([[(])(.*),(.*)([\])])$/.exec(text.trim());
  if (!m) throw new Error(`cannot parse tstzrange '${text}'`);
  return { from: parseBound(m[2] ?? ''), to: parseBound(m[3] ?? '') };
}

export const tstzrange = customType<{ data: TstzRange; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
  toDriver(value) {
    return tstzRange(value);
  },
  fromDriver(value) {
    return parseTstzRange(value);
  },
});
