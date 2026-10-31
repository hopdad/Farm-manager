/**
 * Deere Connections for people (decisions 5 and 6): the approval link with `redirect_uri`, how a
 * stored org row reads back into the 403 kinds, and the public callback forwarder page
 * (docs/deere-callback.html) run in a fake browser: it forwards only code, state, error and
 * error_description to the PC's localhost callback and loads nothing from other hosts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { VendorHttpError } from '../http';
import { approvalLink, connectorsPageUrl, orgStatusView } from './connections';
import { deereOrgAccess, deniedOrgAccess } from './orgs';

const CONNECTIONS = 'https://connections.deere.com/connections/app-1/select-organizations';

describe('approvalLink', () => {
  test('sets redirect_uri (encoded), keeping what the link had', () => {
    const back = connectorsPageUrl('http://localhost:3114/');
    expect(back).toBe('http://localhost:3114/admin/connectors');
    const u = new URL(approvalLink(`${CONNECTIONS}?x=1`, back));
    expect(u.origin + u.pathname).toBe(CONNECTIONS);
    expect(u.searchParams.get('x')).toBe('1');
    expect(u.searchParams.get('redirect_uri')).toBe(back);
    expect(approvalLink(CONNECTIONS, back)).toContain(
      'redirect_uri=http%3A%2F%2Flocalhost%3A3114%2Fadmin%2Fconnectors',
    );
    // Replaces a redirect_uri the link already had; a bad URI is returned as is.
    expect(
      new URL(approvalLink(`${CONNECTIONS}?redirect_uri=x`, back)).searchParams.getAll(
        'redirect_uri',
      ),
    ).toEqual([back]);
    expect(approvalLink('not a url', back)).toBe('not a url');
  });
});

describe('orgStatusView', () => {
  const org = { id: '42', name: 'Customer', links: [] };
  const err = (detail: string, headers?: Record<string, string>) =>
    new VendorHttpError({ vendor: 'deere', status: 403, path: '/isg/equipment', detail, headers });

  test('the stored rows of each 403 kind read back as that kind', () => {
    expect(orgStatusView(deereOrgAccess(org))).toEqual({
      kind: 'connected',
      label: 'connected',
      termsUrl: null,
    });
    const listed = deereOrgAccess({ ...org, links: [{ rel: 'connections', uri: CONNECTIONS }] });
    expect(orgStatusView(listed).kind).toBe('needs_approval');
    expect(orgStatusView(deniedOrgAccess(org, err('Access Denied'))).kind).toBe('needs_approval');
    const terms = deniedOrgAccess(
      org,
      err('Requested org is in a restricted state', {
        'x-deere-terms-location': 'https://teammanager.deere.com/organizations/42/terms',
      }),
    );
    expect(orgStatusView(terms)).toEqual({
      kind: 'terms',
      label: "accept Deere's terms",
      termsUrl: 'https://teammanager.deere.com/organizations/42/terms',
    });
    const scope = deniedOrgAccess(
      org,
      err('The client does not have a proper access for this API'),
    );
    expect(orgStatusView(scope).kind).toBe('scope');
  });
});

describe('docs/deere-callback.html (the public callback forwarder)', () => {
  const html = readFileSync(
    path.join(import.meta.dirname, '..', '..', '..', 'docs', 'deere-callback.html'),
    'utf8',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

  function open(search: string) {
    const replaced: string[] = [];
    const nodes: Record<string, { textContent: string; href: string | null }> = {
      status: { textContent: '', href: null },
      manual: { textContent: '', href: null },
    };
    runInNewContext(script, {
      URLSearchParams,
      window: { location: { search, replace: (u: string) => replaced.push(u) } },
      document: {
        getElementById: (id: string) => {
          const n = nodes[id];
          return n
            ? {
                set textContent(v: string) {
                  n.textContent = v;
                },
                setAttribute: (_k: string, v: string) => {
                  n.href = v;
                },
              }
            : null;
        },
      },
    });
    return { replaced, nodes };
  }

  test('no scripts or styles from other hosts', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(script.length).toBeGreaterThan(0);
  });

  test('forwards code and state (and an error) to the PC, dropping anything else', () => {
    const ok = open('?code=abc%2B1&state=s1&session_state=zzz&extra=1');
    expect(ok.replaced).toHaveLength(1);
    const u = new URL(ok.replaced[0] as string);
    expect(u.origin + u.pathname).toBe('http://localhost:3000/api/oauth/deere');
    expect([...u.searchParams.keys()]).toEqual(['code', 'state']);
    expect(u.searchParams.get('code')).toBe('abc+1');
    expect(ok.nodes.manual?.href).toBe(ok.replaced[0]);

    const denied = open('?error=access_denied&error_description=User+declined&state=s2');
    const d = new URL(denied.replaced[0] as string);
    expect(Object.fromEntries(d.searchParams)).toEqual({
      state: 's2',
      error: 'access_denied',
      error_description: 'User declined',
    });
  });

  test('no Deere answer in the address: stays and says so', () => {
    const none = open('');
    expect(none.replaced).toEqual([]);
    expect(none.nodes.status?.textContent).toMatch(/No Deere sign-in answer/);
  });
});
