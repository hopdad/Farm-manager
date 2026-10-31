/**
 * What /admin/connectors shows about a stored OAuth grant (1f, sync-health): connected or not,
 * the access token's expiry, the scopes granted, when it was last saved, and which required
 * scopes it lacks (a Deere grant made before Oct 31, 2026 lacks `ag2`: sign in again and raise
 * the org's permission in connections.deere.com). Reads the row's metadata only: the tokens
 * themselves stay encrypted (no TOKEN_ENC_KEY needed, nothing secret leaves the database).
 */
import { type Executor, exec, toDate } from '../../db/exec';

export interface GrantInfo {
  source: string;
  /** ingest.oauth_tokens.org_external_id ('' = a real account's user grant, 'sim' = the stand-in's). */
  org: string;
  /** Access-token expiry (the client refreshes before it). */
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
  /** When the grant was last saved (sign-in or refresh). */
  updatedAt: Date | null;
  createdAt: Date | null;
}

/** The grant row of (source, org), or null when not connected. */
export async function readGrantInfo(
  ex: Executor,
  source: string,
  org: string,
): Promise<GrantInfo | null> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select source, org_external_id, expires_at, refresh_expires_at, scopes, created_at, updated_at
       from ingest.oauth_tokens where source = $1 and org_external_id = $2`,
    [source, org],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    source: String(row.source),
    org: String(row.org_external_id),
    expiresAt: toDate(row.expires_at),
    refreshExpiresAt: toDate(row.refresh_expires_at),
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    updatedAt: toDate(row.updated_at),
    createdAt: toDate(row.created_at),
  };
}

/**
 * The required scopes a grant lacks. A grant that names no scopes at all (the token response
 * left `scope` out) is reported as lacking nothing: we can't tell.
 */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  if (granted.length === 0) return [];
  const have = new Set(granted);
  return required.filter((s) => !have.has(s));
}
