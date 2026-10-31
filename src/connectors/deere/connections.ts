/**
 * Deere Connections for people (1f decisions 5 and 6, docs/contracts-1f.md §5.4 and §5.6;
 * owner: sync-health): the "Approve in Deere Connections" links on the sign-in callback page and
 * /admin/connectors, and how an org's stored status reads on the page.
 *
 * Deere's Connections URI is one per client (`https://connections.deere.com/connections/
 * {clientId}/select-organizations`), the same for every org that still needs approval. A
 * `redirect_uri` parameter (confirmed name, URL-encoded) sends the person back after approving,
 * but only when that URL is registered as a Redirect URI in the Deere app profile (else Deere
 * keeps them in Connections). Deere asks apps to send a person there at most once per session:
 * the app only ever shows links, never redirects on its own.
 */
import type { DeereClient } from './client';
import { type DeereOrgAccess, deereOrgAccess } from './orgs';

/** Where a person approves: the org's `connections` link with `redirect_uri` = `returnTo`. */
export function approvalLink(connectionsUri: string, returnTo: string): string {
  try {
    const u = new URL(connectionsUri);
    u.searchParams.set('redirect_uri', returnTo);
    return u.toString();
  } catch {
    return connectionsUri;
  }
}

/** `${PUBLIC_URL}/admin/connectors`: where Deere Connections sends the person back. */
export function connectorsPageUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/admin/connectors`;
}

/** Every org a grant sees, classified (`deereOrgAccess`): one GET /organizations (paged). */
export async function listOrgAccess(client: DeereClient): Promise<DeereOrgAccess[]> {
  return (await client.organizations()).map((o) => deereOrgAccess(o));
}

/** How an org's status reads on /admin/connectors. */
export interface OrgStatusView {
  /**
   * connected; needs_approval (approve in Deere Connections); terms (accept Deere's terms at
   * `termsUrl`: a Required Customer Action); scope (the app's grant or API licence: sign in again
   * with every scope of DEERE_SCOPES, raise the org's permission, or license the API in My
   * Applications).
   */
  kind: 'connected' | 'needs_approval' | 'terms' | 'scope';
  label: string;
  termsUrl: string | null;
}

const TERMS_RE = /accept Deere's terms at (\S+)/;
const SCOPE_RE = /the app's scopes or API licence/;

/**
 * Read a stored org row (ingest.connector_orgs) back into the 403 kinds of `deereDenialOf`: the
 * detail `deniedOrgAccess` wrote names terms (with the URL) or the app's scopes/licence.
 */
export function orgStatusView(row: { status: string; detail: string | null }): OrgStatusView {
  if (row.status === 'connected') return { kind: 'connected', label: 'connected', termsUrl: null };
  const detail = row.detail ?? '';
  const terms = TERMS_RE.exec(detail);
  if (terms?.[1]) {
    return { kind: 'terms', label: "accept Deere's terms", termsUrl: terms[1] };
  }
  if (SCOPE_RE.test(detail)) {
    return { kind: 'scope', label: "the app's configuration (scope or licence)", termsUrl: null };
  }
  return { kind: 'needs_approval', label: 'needs approval', termsUrl: null };
}
