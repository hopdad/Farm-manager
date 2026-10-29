/**
 * Shared SQL and plumbing for the field-data writers (boundaries, lineage, seasons, parties):
 * one transaction helper, the geometry normalization every boundary write goes through, and the
 * realtime fan-out after a change (docs/contracts-m1.md §6 fields/updated).
 *
 * Every write here runs as farm_app through a pg pool (the app's getPool(), a CLI's own pool,
 * a test database's pool) in an explicit transaction, and publishes in that transaction, so a
 * message is delivered on commit and never for a rolled-back change.
 */
import type pg from 'pg';
import type { FieldPart } from '../../domain/fields';
import { publish } from '../../platform/realtime/publish';

/** Who made a change (from the server-side Session; never from the browser). */
export interface Actor {
  appUserId: string | null;
  displayName: string;
}

/** The CLI's actor (imports and data:import run on the PC by whoever is at it). */
export const CLI_ACTOR: Actor = Object.freeze({ appUserId: null, displayName: 'command line' });

/** A refusal the user can act on (bad input, a conflict, a read-only Deere boundary). */
export class FieldDataError extends Error {
  override name = 'FieldDataError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'conflict' | 'read_only' | 'stale' = 'invalid',
  ) {
    super(message);
  }
}

/** Run `fn` in one transaction on a pooled client; rolls back on throw or when `rollback` is set. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
  opts: { rollback?: boolean } = {},
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query(opts.rollback ? 'rollback' : 'commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * A GeoJSON parameter ($n, text) as a valid 2D MultiPolygon in EPSG:4326: Z/M dropped, made
 * valid with GEOS's "structure" method (overlapping parts of one field are unioned, bow-ties
 * split), lines and points from the repair thrown away. Empty when nothing polygonal is left.
 */
export const NORMALIZED_POLYGON = (param: string) =>
  `extensions.ST_Multi(extensions.ST_CollectionExtract(extensions.ST_MakeValid(
     extensions.ST_Force2D(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(${param}::text), 4326)),
     'method=structure'), 3))`;

/** Geodesic acres of a geometry expression (same formula as the boundary trigger). */
export const ACRES = (geom: string) =>
  `(extensions.ST_Area((${geom})::extensions.geography) / 4046.86)`;

/** Lower-cased, single-spaced, trimmed text (names are matched with it in SQL and in TS). */
export const NORM_TEXT = (expr: string) =>
  `lower(regexp_replace(btrim(${expr}), '\\s+', ' ', 'g'))`;
export const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Smallest boundary the app accepts (a slip of the finger or a sliver from a bad file). */
export const MIN_BOUNDARY_ACRES = 0.1;

/** Above this many changed fields one `invalidate` replaces the per-field messages. */
export const MAX_FIELD_MESSAGES = 25;

/** Collects which parts of which fields changed, then publishes them in the transaction. */
export class FieldChanges {
  private readonly parts = new Map<string, Set<FieldPart>>();

  add(fieldId: string, ...parts: FieldPart[]): void {
    let s = this.parts.get(fieldId);
    if (!s) {
      s = new Set();
      this.parts.set(fieldId, s);
    }
    for (const p of parts) s.add(p);
  }

  get size(): number {
    return this.parts.size;
  }

  fieldIds(): string[] {
    return [...this.parts.keys()];
  }

  /** fields/updated per field, or one fields/invalidate when many changed. */
  async publish(c: pg.PoolClient): Promise<void> {
    if (this.parts.size === 0) return;
    if (this.parts.size > MAX_FIELD_MESSAGES) {
      await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, c);
      return;
    }
    for (const [fieldId, parts] of this.parts) {
      await publish('fields', 'updated', { fieldId, parts: [...parts].sort() }, c);
    }
  }
}

/** ISO string of a timestamptz from pg (Date) or text. */
export function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}
