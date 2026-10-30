/**
 * POST /api/webhooks/<source>: vendor webhooks only nudge (plan §5, src/connectors/webhooks.ts):
 * verify, land in ingest.raw_events, make the source's streams due, 200. Never processes
 * inline and never answers 3xx (contracts §5). A mode that takes no webhooks is refused before
 * the body is read, and the body is read with a 4 MB cap (chunked bodies have no length).
 */
import { getConfig } from '@/config';
import { connectionMode, connectionOfSource } from '@/connectors/vendors';
import {
  handleWebhook,
  isWebhookSource,
  MAX_WEBHOOK_BYTES,
  simWebhookSecret,
  webhookModeRefusal,
} from '@/connectors/webhooks';
import { getPool } from '@/db/client';
import { limitedJson, readLimitedText } from '@/platform/http/limits';

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
  const cfg = getConfig();
  // Each source's own mode key (1f.2: every telematics vendor has one).
  const connection = connectionOfSource(source);
  const mode = connection ? connectionMode(cfg, connection) : 'off';
  const refused = webhookModeRefusal(source, mode);
  if (refused) return limitedJson(refused.body, { status: refused.status, headers });
  const body = await readLimitedText(request, MAX_WEBHOOK_BYTES);
  if (body === null) return limitedJson({ error: 'body over 4 MB' }, { status: 413, headers });
  try {
    const out = await handleWebhook(getPool(), {
      source,
      mode,
      body,
      headers: request.headers,
      now: new Date(),
      simSecret: simWebhookSecret(cfg.SESSION_SECRET, source),
    });
    return limitedJson(out.body, { status: out.status, headers });
  } catch (e) {
    console.error(`[api/webhooks/${source}]`, (e as Error).message);
    return limitedJson({ error: 'webhook not stored' }, { status: 500, headers });
  }
}
