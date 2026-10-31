/**
 * The `poll` of deere.ops (slice 1f, deere-ops; docs/contracts-1f.md §5.1, §5.4, §5.5): this crop
 * season's field operations of every connected org, as raw items. Never writes; it may read
 * what is stored (through `storedModified`) to skip operations that haven't changed.
 *
 *  1. GET /organizations; orgs whose listing carries a `connections` link need approval and are
 *     skipped (logged), and so is any org that answers 403 mid-run (decision 5), unless the 403
 *     says the grant lacks a scope (`deereDenialOf` = 'scope'): then no org can work and the
 *     step fails with what to do (sign in again with `ag2`).
 *  2. GET /organizations/{org}/fields per org (archived fields skipped).
 *  3. The fields checked longest ago first (never-checked first), at most `fieldCap` of them
 *     (decision 4: the per-run cap from the call budget; null = every field), and none started
 *     after `stopAt` (the rest wait for the next run, checked first then).
 *  4. Per field: GET …/fieldOperations?cropSeason=<year>&embed=measurementTypes. An operation
 *     whose `modifiedTime` equals the stored one is unchanged and costs no more calls; for the
 *     others the measurements (when not embedded) and the coverage are read. A coverage refusal
 *     (400: the field has an active boundary, or was merged) is remembered per field for
 *     REFUSED_TTL_MS, so the next operations on that field don't spend a call on it.
 *
 * The cursor (JSON, ingest.sync_state.cursor) keeps each field's last check (`checked`) and the
 * fields whose coverage was refused (`refused`); fields no longer listed by an org that listed
 * fine are dropped from it.
 */

import { operationKindOf } from '../../../domain/operations';
import type { JobLogger } from '../../../jobs/types';
import { VendorHttpError } from '../../http';
import type { PollResult, RawItem } from '../../types';
import type { DeereClient } from '../client';
import { deereDenialOf, deereOrgAccess, isDeereOrgDenied } from '../orgs';
import { fieldOperationCoverage, listFieldOperations, measurementsOf } from './client';
import type { DeereOperationRaw } from './schemas';

/** How long a field's coverage refusal (400) is trusted before the boundary call is tried again. */
export const REFUSED_TTL_MS = 7 * 86_400_000;

export interface OpsCursor {
  v: 1;
  /** `<org>|<field>` → ISO time the field's operations were last listed. */
  checked: Record<string, string>;
  /** `<org>|<field>` → ISO time Deere last refused a coverage of the field (400). */
  refused: Record<string, string>;
}

export const fieldKey = (orgId: string, fieldId: string) => `${orgId}|${fieldId}`;

/** The stored cursor, or a fresh one (an unreadable or foreign cursor starts over). */
export function parseOpsCursor(cursor: string | null): OpsCursor {
  const fresh: OpsCursor = { v: 1, checked: {}, refused: {} };
  if (!cursor) return fresh;
  try {
    const c = JSON.parse(cursor) as Partial<OpsCursor>;
    if (c?.v !== 1) return fresh;
    const strings = (o: unknown): Record<string, string> =>
      o && typeof o === 'object'
        ? Object.fromEntries(
            Object.entries(o as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : {};
    return { v: 1, checked: strings(c.checked), refused: strings(c.refused) };
  } catch {
    return fresh;
  }
}

export interface FieldToCheck {
  orgId: string;
  fieldId: string;
}

/**
 * The fields to check this run: longest ago first (never-checked first; ties in org, field
 * order), at most `cap` (null = all).
 */
export function fieldsToCheck(
  candidates: readonly FieldToCheck[],
  checked: Readonly<Record<string, string>>,
  cap: number | null,
): FieldToCheck[] {
  const at = (f: FieldToCheck) => checked[fieldKey(f.orgId, f.fieldId)] ?? '';
  const sorted = [...candidates].sort(
    (a, b) =>
      at(a).localeCompare(at(b)) ||
      a.orgId.localeCompare(b.orgId) ||
      a.fieldId.localeCompare(b.fieldId),
  );
  return cap === null ? sorted : sorted.slice(0, Math.max(0, cap));
}

/** Thrown when Deere refuses because the grant lacks a scope (no org can work: fail the step). */
export class DeereScopeError extends Error {
  constructor(cause: VendorHttpError) {
    super(
      `Deere refused field operations (${cause.path}: ${cause.detail ?? 'HTTP 403'}): the grant lacks scope ag2. Sign in again at /api/oauth/deere and raise the org's permission in connections.deere.com`,
    );
    this.name = 'DeereScopeError';
  }
}

export interface OpsPollDeps {
  client: DeereClient;
  now(): Date;
  /** No new field is started at or after this instant (the rest wait for the next run). */
  stopAt: Date;
  /** The crop year listed (`cropSeason`). */
  cropSeason: number;
  /** Fields one run may check (decision 4); null = every field. */
  fieldCap: number | null;
  /** The stored `source_modified_at` (ISO) of operations already written, by Deere operation id. */
  storedModified(operationIds: readonly string[]): Promise<Map<string, string | null>>;
  log: JobLogger;
}

export interface OpsPollStats {
  /** Orgs listed / skipped (needs approval, terms, 403). */
  orgs: number;
  skippedOrgs: string[];
  /** Fields the orgs list, and how many this run checked. */
  fields: number;
  fieldsChecked: number;
  /** Operations seen, landed (new or changed) and skipped as unchanged. */
  operations: number;
  landed: number;
  unchanged: number;
}

export type OpsPollResult = PollResult<RawItem<DeereOperationRaw>> & { stats: OpsPollStats };

const isoOrNull = (t: string | undefined) => (t ? new Date(t).toISOString() : null);

/** A 403 that isn't about the org: rethrow as DeereScopeError; else the denial kind. */
function denialOf(e: VendorHttpError): 'needs_approval' | 'terms' {
  const kind = deereDenialOf(e);
  if (kind === 'scope') throw new DeereScopeError(e);
  return kind;
}

export async function pollDeereOperations(
  cursor: string | null,
  deps: OpsPollDeps,
): Promise<OpsPollResult> {
  const { client, log } = deps;
  const cur = parseOpsCursor(cursor);
  const stats: OpsPollStats = {
    orgs: 0,
    skippedOrgs: [],
    fields: 0,
    fieldsChecked: 0,
    operations: 0,
    landed: 0,
    unchanged: 0,
  };
  const skipOrg = (orgId: string, why: string) => {
    if (!stats.skippedOrgs.includes(orgId)) stats.skippedOrgs.push(orgId);
    log.info('deere.ops: org skipped', { orgId, why });
  };

  // 1-2: orgs and their fields.
  const candidates: FieldToCheck[] = [];
  const listedOrgs = new Set<string>();
  for (const org of await client.organizations()) {
    stats.orgs++;
    const access = deereOrgAccess(org);
    if (access.status !== 'connected') {
      skipOrg(org.id, 'needs approval in Deere Connections');
      continue;
    }
    try {
      for (const f of await client.fields(org.id)) {
        if (!f.archived) candidates.push({ orgId: org.id, fieldId: f.id });
      }
      listedOrgs.add(org.id);
    } catch (e) {
      if (!isDeereOrgDenied(e)) throw e;
      skipOrg(org.id, `403 from the fields listing (${denialOf(e)})`);
    }
  }
  stats.fields = candidates.length;

  // 3: which fields this run.
  const todo = fieldsToCheck(candidates, cur.checked, deps.fieldCap);
  const items: RawItem<DeereOperationRaw>[] = [];
  const deniedOrgs = new Set<string>();
  let left = 0;

  // 4: per field.
  for (const f of todo) {
    if (deps.now().getTime() >= deps.stopAt.getTime()) {
      left = todo.length - stats.fieldsChecked;
      break;
    }
    if (deniedOrgs.has(f.orgId)) continue;
    const key = fieldKey(f.orgId, f.fieldId);
    try {
      const ops = (
        await listFieldOperations(client, f.orgId, f.fieldId, { cropSeason: deps.cropSeason })
      ).filter((op) => operationKindOf(op.fieldOperationType) !== null);
      stats.operations += ops.length;
      const stored = ops.length ? await deps.storedModified(ops.map((o) => o.id)) : new Map();
      const refusedAt = cur.refused[key];
      let refused =
        refusedAt !== undefined && deps.now().getTime() - Date.parse(refusedAt) < REFUSED_TTL_MS;
      for (const op of ops) {
        const modified = isoOrNull(op.modifiedTime);
        if (modified && stored.get(op.id) === modified) {
          stats.unchanged++;
          continue;
        }
        const measurements = await measurementsOf(client, op);
        let coverage: DeereOperationRaw['coverage'] = null;
        let coverageStatus: DeereOperationRaw['coverageStatus'] = 'skipped';
        if (!refused) {
          const reply = await fieldOperationCoverage(client, op.id);
          if (reply.status === 'ok') {
            coverage = reply.boundary;
            coverageStatus = 'ok';
          } else {
            refused = true;
            coverageStatus = 'refused';
            cur.refused[key] = deps.now().toISOString();
          }
        }
        items.push({
          externalId: op.id,
          payload: {
            orgId: f.orgId,
            fieldId: f.fieldId,
            operation: op,
            measurements,
            coverage,
            coverageStatus,
          },
        });
        stats.landed++;
      }
      cur.checked[key] = deps.now().toISOString();
      stats.fieldsChecked++;
    } catch (e) {
      if (isDeereOrgDenied(e)) {
        deniedOrgs.add(f.orgId);
        skipOrg(f.orgId, `403 from ${e.path} (${denialOf(e)})`);
        continue;
      }
      if (e instanceof VendorHttpError && e.status === 404) {
        // The field went away between the listing and this call: nothing to read.
        log.info('deere.ops: field not found; skipped', { orgId: f.orgId, fieldId: f.fieldId });
        cur.checked[key] = deps.now().toISOString();
        stats.fieldsChecked++;
        continue;
      }
      throw e;
    }
  }
  if (left > 0) log.info('deere.ops: out of time; fields left for the next run', { left });

  // Forget fields an org no longer lists (only orgs that listed fine this run).
  const listed = new Set(candidates.map((c) => fieldKey(c.orgId, c.fieldId)));
  for (const map of [cur.checked, cur.refused]) {
    for (const k of Object.keys(map)) {
      const org = k.slice(0, k.indexOf('|'));
      if (listedOrgs.has(org) && !listed.has(k)) delete map[k];
    }
  }
  return { items, cursor: JSON.stringify(cur), hasMore: false, stats };
}
