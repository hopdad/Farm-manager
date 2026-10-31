/** The Deere sign-in callback page's body (decision 5): "Connected", plus the orgs to approve. */
import { describe, expect, test } from 'vitest';
import type { DeereOrgAccess } from '@/connectors/deere/orgs';
import { connectedBody } from './callback-page';

const CONNECTIONS = 'https://connections.deere.com/connections/app/select-organizations';
const org = (orgId: string, status: DeereOrgAccess['status'], name: string | null = null) => ({
  orgId,
  name,
  status,
  approvalUrl: status === 'needs_approval' ? CONNECTIONS : null,
  detail: null,
});

describe('connectedBody', () => {
  test('no org waiting (or the listing failed): "Connected" as before', () => {
    for (const orgs of [null, [], [org('1', 'connected')]]) {
      const html = connectedBody(false, orgs, 'http://localhost:3000');
      expect(html).toMatch(/Deere is connected/);
      expect(html).not.toMatch(/Approve in Deere Connections/);
      expect(html).toMatch(/href="\/admin\/connectors"/);
    }
    expect(connectedBody(true, null, 'http://localhost:3000')).toMatch(/simulated Deere account/);
  });

  test('each org that needs approval, with a link back to /admin/connectors', () => {
    const html = connectedBody(
      false,
      [
        org('1', 'connected', 'Home'),
        org('2', 'needs_approval', 'Smith <Farms>'),
        org('3', 'needs_approval'),
      ],
      'http://localhost:3000/',
    );
    expect(html).toMatch(/2 organizations still need/);
    expect(html.match(/Approve in Deere Connections/g)).toHaveLength(2);
    expect(html).toContain('data-org="2"');
    expect(html).toContain('Smith &#60;Farms&#62;'); // escaped
    expect(html).not.toContain('data-org="1"');
    const hrefs = [...html.matchAll(/class="approve" href="([^"]+)"/g)].map(
      (m) => new URL((m[1] as string).replaceAll('&#38;', '&')),
    );
    expect(hrefs).toHaveLength(2);
    for (const h of hrefs) {
      expect(h.searchParams.get('redirect_uri')).toBe('http://localhost:3000/admin/connectors');
    }
    expect(html).toMatch(/data-rights agreement/);
  });
});
