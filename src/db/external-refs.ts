/**
 * ingest.external_refs: vendor id -> our entity id. The demo seed writes these rows and every
 * sync reads them, both through this module, with refs built by `externalRef()` from
 * src/connectors/types.ts (the kind vocabulary and the exact tuples are documented there and in
 * docs/contracts.md §4/§9; the simulated farm's rows come from `simExternalRefs()`).
 *
 * All helpers take a pg Pool/PoolClient or a Drizzle db/tx (src/db/exec.ts), so they work in a
 * sync step's per-event `tx` and in the seed's transaction alike.
 */
import type { ExternalRef, ExternalRefKind, ConnectorSource } from '../connectors/types';
import { type Executor, exec } from './exec';

/**
 * Insert or re-point one ref. Idempotent: an unchanged mapping writes nothing; a changed
 * entity id (e.g. a field match after review) replaces the old one.
 */
export async function upsertExternalRef(
  ex: Executor,
  ref: ExternalRef,
  entityId: string,
): Promise<void> {
  await exec(
    ex,
    `insert into ingest.external_refs (source, kind, external_id, source_org, entity_id)
     values ($1, $2, $3, $4, $5::uuid)
     on conflict (source, kind, external_id, source_org) do update
       set entity_id = excluded.entity_id, updated_at = now()
       where ingest.external_refs.entity_id is distinct from excluded.entity_id`,
    [ref.source, ref.kind, ref.externalId, ref.sourceOrg, entityId],
  );
}

/** The entity id a ref points at, or null when it isn't mapped (yet). */
export async function resolveExternalRef(ex: Executor, ref: ExternalRef): Promise<string | null> {
  const r = await exec<{ entity_id: string }>(
    ex,
    `select entity_id::text as entity_id from ingest.external_refs
      where source = $1 and kind = $2 and external_id = $3 and source_org = $4`,
    [ref.source, ref.kind, ref.externalId, ref.sourceOrg],
  );
  return r.rows[0]?.entity_id ?? null;
}

/**
 * Batch lookup for one (source, kind, sourceOrg): externalId -> entity id. Ids that aren't
 * mapped are absent from the result (log and skip those items; don't invent entities).
 */
export async function resolveExternalRefs(
  ex: Executor,
  source: ConnectorSource,
  kind: ExternalRefKind,
  sourceOrg: string,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(externalIds)];
  if (!ids.length) return out;
  const r = await exec<{ external_id: string; entity_id: string }>(
    ex,
    `select external_id, entity_id::text as entity_id from ingest.external_refs
      where source = $1 and kind = $2 and source_org = $3 and external_id = any($4::text[])`,
    [source, kind, sourceOrg, ids],
  );
  for (const row of r.rows) out.set(row.external_id, row.entity_id);
  return out;
}
