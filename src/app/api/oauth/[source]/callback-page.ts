/**
 * The Deere sign-in callback page's body (/api/oauth/deere, decision 5): kept apart from the
 * route file (Next route modules export only handlers and route config) so it is unit-tested.
 */
import { approvalLink, connectorsPageUrl } from '@/connectors/deere/connections';
import type { DeereOrgAccess } from '@/connectors/deere/orgs';
import { escapeHtml } from '@/connectors/oauth/flow';

/**
 * The callback page's body after a successful exchange: "Connected", plus (decision 5) the orgs
 * that still need approval, each with an "Approve in Deere Connections" link back to
 * /admin/connectors.
 */
export function connectedBody(
  sim: boolean,
  orgs: readonly DeereOrgAccess[] | null,
  publicUrl: string,
): string {
  const head = `<p>${sim ? 'Connected to the simulated Deere account.' : 'Deere is connected.'} Machine locations sync on the next fleet.deere run.</p>`;
  const links = `<p><a href="/admin/connectors">Connectors</a> · <a href="/board">Board</a></p>`;
  const waiting = (orgs ?? []).filter((o) => o.status === 'needs_approval' && o.approvalUrl);
  if (waiting.length === 0) return `${head}\n${links}`;
  const back = connectorsPageUrl(publicUrl);
  const items = waiting
    .map((o) => {
      const href = approvalLink(o.approvalUrl as string, back);
      return `<li data-org="${escapeHtml(o.orgId)}"><strong>${escapeHtml(o.name ?? o.orgId)}</strong> <span>(${escapeHtml(o.orgId)})</span><br><a class="approve" href="${escapeHtml(href)}">Approve in Deere Connections</a></li>`;
    })
    .join('\n');
  return `${head}
<p>${waiting.length === 1 ? 'One organization still needs' : `${waiting.length} organizations still need`} to approve this app in Deere Connections before it syncs. Deere sends you back to Connectors afterwards.</p>
<ul data-testid="orgs-need-approval">${items}</ul>
<p>Customer organizations are connected only after a data-rights agreement.</p>
${links}`;
}
