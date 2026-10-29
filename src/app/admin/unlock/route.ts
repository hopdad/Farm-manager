/**
 * GET /admin/unlock?key=<admin key>: sets the admin cookie (src/platform/auth/admin-key.ts) and
 * shows a link to /admin/connectors. `pnpm dev` / `pnpm pilot` print the link with the key on the
 * PC's console. Never 3xx: a page with a link and a meta refresh, like /api/oauth.
 */
import { getConfig } from '@/config';
import { unlockResponse } from '../_lib/unlock';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return unlockResponse(getConfig(), request.url);
}
