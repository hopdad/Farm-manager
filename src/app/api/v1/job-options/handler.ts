/**
 * GET /api/v1/job-options -> 200 `JobOptionsResponse` (src/ui/work/contract.ts; job-forms,
 * docs/contracts-2a.md §5.2): what the job form picks from (active products, customers, fields
 * with a current boundary, the crop years). Framework-free (the DB test calls it under
 * runWithSession):
 *
 *  - requireRole(ROLE_FOR.viewPrivate) FIRST (401/403 JSON otherwise): a viewer may read it (the
 *    form is only offered to managers, and every job write checks planJobs again);
 *  - 503 when the database is unavailable (logged);
 *  - `Cache-Control: no-store`, through limitedJson; the realtime adapter and the app's
 *    environment ride in two headers (JOB_FORMS_REALTIME_HEADER, JOB_FORMS_APP_ENV_HEADER, the
 *    History tab's pair), so the field panel's Jobs tab, which gets no config
 *    (src/ui/fields/tabs.ts), can subscribe to `jobs` (src/ui/fields/tabs/jobs/loader.ts).
 *
 * HEAD /api/v1/job-options answers the same status and headers with no body and no query: the
 * Jobs tab's one probe for the realtime mode when the jobs snapshot doesn't carry the headers.
 */
import { type Config, getConfig } from '@/config';
import type { Executor } from '@/db/exec';
import { jobOptions } from '@/db/queries/job-options';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedBytes, limitedJson } from '@/platform/http/limits';
import { JOB_FORMS_APP_ENV_HEADER, JOB_FORMS_REALTIME_HEADER } from '@/ui/work/forms/protocol';

const ROUTE = { route: 'api/v1/job-options' };

type HeaderConfig = Pick<Config, 'NEXT_PUBLIC_REALTIME' | 'APP_ENV'>;

function headersFor(cfg: HeaderConfig): Record<string, string> {
  return {
    'cache-control': 'no-store',
    [JOB_FORMS_REALTIME_HEADER]: cfg.NEXT_PUBLIC_REALTIME,
    [JOB_FORMS_APP_ENV_HEADER]: cfg.APP_ENV,
  };
}

async function authorize(): Promise<Response | null> {
  try {
    await requireRole(ROLE_FOR.viewPrivate);
    return null;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
}

export async function handleJobOptions(
  ex: Executor,
  now: Date = new Date(),
  cfg: () => HeaderConfig = getConfig,
): Promise<Response> {
  const refused = await authorize();
  if (refused) return refused;
  try {
    const body = await jobOptions(ex, now);
    return limitedJson(body, { headers: headersFor(cfg()) }, ROUTE);
  } catch (e) {
    console.error('[api/v1/job-options]', (e as Error).message);
    return limitedJson(
      { error: 'job options unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
      ROUTE,
    );
  }
}

export async function handleJobOptionsHead(cfg: () => HeaderConfig = getConfig): Promise<Response> {
  const refused = await authorize();
  if (refused) return limitedBytes('', { status: refused.status, headers: refused.headers }, ROUTE);
  return limitedBytes('', { status: 200, headers: headersFor(cfg()) }, ROUTE);
}
