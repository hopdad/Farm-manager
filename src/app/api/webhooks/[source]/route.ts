/**
 * POST /api/webhooks/<source>: vendor webhooks only nudge (plan §5, src/connectors/webhooks.ts):
 * verify, land in ingest.raw_events, make the source's streams due, 200. Never processes
 * inline and never answers 3xx (contracts §5).
 */
import { getConfig } from '@/config';
import { handleWebhook, isWebhookSource, MAX_WEBHOOK_BYTES } from '@/connectors/webhooks';
import { getPool } from '@/db/client';
import { limitedJson } from '@/platform/http/limits';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
): Promise<Response> {
  const { source } = await params;
  const headers = { 'cache-control': 'no-store' };
  if (!isWebhookSource(source)) {
    return limitedJson({ error: `no webhooks for '${source}'` }, { status: 404, headers });
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_WEBHOOK_BYTES) {
    return limitedJson({ error: 'body over 4 MB' }, { status: 413, headers });
  }
  const cfg = getConfig();
  const mode =
    source === 'deere'
      ? cfg.CONNECTOR_DEERE
      : cfg.ELD_VENDOR === source
        ? cfg.CONNECTOR_ELD
        : 'off';
  try {
    const out = await handleWebhook(getPool(), {
      source,
      mode,
      body: await request.text(),
      headers: request.headers,
      now: new Date(),
    });
    return limitedJson(out.body, { status: out.status, headers });
  } catch (e) {
    console.error(`[api/webhooks/${source}]`, (e as Error).message);
    return limitedJson({ error: 'webhook not stored' }, { status: 500, headers });
  }
}
