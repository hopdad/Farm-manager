/**
 * ingest.connector_orgs (1f decision 5, docs/contracts-1f.md §3.1 and §5.4; owner: sync-health):
 * the vendor orgs a connection sees, per connector mode, with their approval status. Only the
 * fleet.deere locations step writes it (it lists every org every run); /admin/connectors shows
 * the current mode's rows.
 *
 * After a SUCCESSFUL org listing the writer deletes that source and mode's rows the listing no
 * longer has, so after a switch from sim to sandbox the sim orgs never show as connected (they
 * stay under mode 'sim', and the page reads the current mode only).
 */
import type { DeereOrgAccess, DeereOrgStatus } from '../../connectors/deere/orgs';
import type { CountedMode } from '../../connectors/types';
import { type Executor, exec, toDate } from '../exec';

export interface ConnectorOrgRow {
  source: string;
  mode: CountedMode;
  orgId: string;
  name: string | null;
  status: DeereOrgStatus;
  approvalUrl: string | null;
  detail: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const clip = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 3)}...` : s) : null;

/**
 * Upsert the orgs one run saw (status, name, approval link, detail; first_seen_at kept), then,
 * when `listed` (the org listing itself succeeded), delete this source and mode's rows that are
 * not among them. Returns how many rows were removed.
 */
export async function saveConnectorOrgs(
  ex: Executor,
  source: string,
  mode: CountedMode,
  orgs: readonly DeereOrgAccess[],
  opts: { listed: boolean },
): Promise<{ saved: number; removed: number }> {
  const payload = orgs.map((o) => ({
    id: o.orgId,
    name: clip(o.name, 200),
    status: o.status,
    url: clip(o.approvalUrl, 1000),
    detail: clip(o.detail, 300),
  }));
  let saved = 0;
  if (payload.length) {
    const r = await exec(
      ex,
      `insert into ingest.connector_orgs
         (source, mode, org_external_id, name, status, approval_url, detail)
       select $1, $2, x->>'id', x->>'name', x->>'status', x->>'url', x->>'detail'
         from jsonb_array_elements($3::jsonb) as x
       on conflict (source, mode, org_external_id) do update
         set name = excluded.name, status = excluded.status,
             approval_url = excluded.approval_url, detail = excluded.detail,
             last_seen_at = now(), updated_at = now()`,
      [source, mode, JSON.stringify(payload)],
    );
    saved = r.rowCount;
  }
  let removed = 0;
  if (opts.listed) {
    const r = await exec(
      ex,
      `delete from ingest.connector_orgs
        where source = $1 and mode = $2 and not (org_external_id = any($3::text[]))`,
      [source, mode, orgs.map((o) => o.orgId)],
    );
    removed = r.rowCount;
  }
  return { saved, removed };
}

/** The orgs of one source and mode (name order, then id). */
export async function listConnectorOrgs(
  ex: Executor,
  source: string,
  mode: string,
): Promise<ConnectorOrgRow[]> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select source, mode, org_external_id, name, status, approval_url, detail,
            first_seen_at, last_seen_at
       from ingest.connector_orgs
      where source = $1 and mode = $2
      order by coalesce(name, org_external_id), org_external_id`,
    [source, mode],
  );
  return r.rows.map((x) => ({
    source: String(x.source),
    mode: x.mode as CountedMode,
    orgId: String(x.org_external_id),
    name: (x.name as string | null) ?? null,
    status: x.status as DeereOrgStatus,
    approvalUrl: (x.approval_url as string | null) ?? null,
    detail: (x.detail as string | null) ?? null,
    firstSeenAt: toDate(x.first_seen_at) as Date,
    lastSeenAt: toDate(x.last_seen_at) as Date,
  }));
}

/**
 * Merge `patch` into one stream's ingest.sync_state.extra (`extra = coalesce(extra, '{}') ||
 * patch`: other writers' keys are kept, docs/contracts-1f.md §3.1). No row = nothing written.
 */
export async function mergeSyncStateExtra(
  ex: Executor,
  source: string,
  stream: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const r = await exec(
    ex,
    `update ingest.sync_state set extra = coalesce(extra, '{}'::jsonb) || $3::jsonb
      where source = $1 and stream = $2`,
    [source, stream, JSON.stringify(patch)],
  );
  return r.rowCount > 0;
}

/** What fleet.deere keeps about the home org (sync_state deere/locations `extra.homeOrg`). */
export interface StoredHomeOrg {
  orgId: string | null;
  source: string;
  mode: string;
  /** The orgs of the listing it was decided from (to pick DEERE_HOME_ORG_ID from). */
  candidates: { id: string; name: string | null; member: boolean | null }[];
  at: string;
}

/** Read `extra.homeOrg` leniently (null when missing or malformed). */
export function storedHomeOrgOf(extra: unknown): StoredHomeOrg | null {
  const h = (extra as { homeOrg?: unknown } | null)?.homeOrg as Partial<StoredHomeOrg> | undefined;
  if (!h || typeof h !== 'object' || typeof h.source !== 'string') return null;
  return {
    orgId: typeof h.orgId === 'string' ? h.orgId : null,
    source: h.source,
    mode: typeof h.mode === 'string' ? h.mode : '',
    candidates: Array.isArray(h.candidates)
      ? h.candidates
          .filter((c): c is StoredHomeOrg['candidates'][number] => !!c && typeof c.id === 'string')
          .map((c) => ({ id: c.id, name: c.name ?? null, member: c.member ?? null }))
      : [],
    at: typeof h.at === 'string' ? h.at : '',
  };
}
