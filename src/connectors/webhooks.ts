/**
 * Vendor webhooks only NUDGE (plan §5): answer the verification handshake, land the body in
 * ingest.raw_events (stream 'webhook'), set the source's streams due now
 * (sync_state.next_run_at = now()) and return 200. Nothing is processed inline; the next
 * clock tick runs the stream (and M1 processes the webhook inbox).
 *
 * Signatures (HMAC-SHA256 over `v1:<timestamp>:<raw body>`, key = base64-decoded secret,
 * header `v1=<hex>`, timestamps within 5 minutes):
 *   samsara  X-Samsara-Signature / X-Samsara-Timestamp   (Samsara webhooks 2.0 scheme)
 *   deere    X-Deere-Signature / X-Deere-Timestamp       // doc-derived, confirm
 *   motive   X-Motive-Signature / X-Motive-Timestamp     // doc-derived, confirm
 * In sim mode the secret is simWebhookSecret(SESSION_SECRET, source): per install, so nobody on
 * the LAN can forge a "signed" body from constants in the repo (the stand-in derives the same
 * secret from the same config once it sends webhooks). Real secrets need config keys that don't
 * exist yet (SAMSARA_WEBHOOK_SECRET, …), so sandbox/live webhooks are refused (503) instead of
 * being accepted unsigned. The route refuses off/sandbox/live before it reads the body.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type Executor, exec } from '../db/exec';
import type { Mode } from './types';

export const WEBHOOK_SOURCES = ['samsara', 'deere', 'motive'] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

/** ingest.raw_events.stream of landed webhook bodies (the webhook inbox). */
export const WEBHOOK_STREAM = 'webhook';

/** sync_state streams a webhook from each source makes due. */
export const WEBHOOK_NUDGES: Record<WebhookSource, readonly string[]> = {
  samsara: ['positions', 'stats'],
  deere: ['locations'],
  motive: ['positions'],
};

/** The sim-mode signing secret of `source` (base64), derived from this install's SESSION_SECRET. */
export function simWebhookSecret(sessionSecret: string, source: WebhookSource): string {
  return createHmac('sha256', sessionSecret).update(`sim-webhook:${source}`).digest('base64');
}

const SIGNATURE_HEADERS: Record<WebhookSource, { signature: string; timestamp: string }> = {
  samsara: { signature: 'x-samsara-signature', timestamp: 'x-samsara-timestamp' },
  deere: { signature: 'x-deere-signature', timestamp: 'x-deere-timestamp' },
  motive: { signature: 'x-motive-signature', timestamp: 'x-motive-timestamp' },
};

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;

export function isWebhookSource(s: string): s is WebhookSource {
  return (WEBHOOK_SOURCES as readonly string[]).includes(s);
}

/** `v1=<hex>` for a body at `timestamp` (unix seconds). Used by the stand-in and the tests. */
export function signWebhook(secretB64: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', Buffer.from(secretB64, 'base64'))
    .update(`v1:${timestamp}:${body}`)
    .digest('hex');
  return `v1=${mac}`;
}

export function verifyWebhookSignature(
  secretB64: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now: Date,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const want = Buffer.from(signWebhook(secretB64, timestamp, body));
  return signature
    .split(',')
    .map((s) => Buffer.from(s.trim()))
    .some((got) => got.length === want.length && timingSafeEqual(got, want));
}

export interface WebhookInput {
  source: WebhookSource;
  mode: Mode;
  body: string;
  headers: Headers;
  now: Date;
  /** simWebhookSecret(cfg.SESSION_SECRET, source): what sim-mode bodies are signed with. */
  simSecret: string;
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** The answer for a connector mode that takes no webhooks (off: 404; sandbox/live: 503), or null. */
export function webhookModeRefusal(source: WebhookSource, mode: Mode): WebhookOutcome | null {
  if (mode === 'off') return { status: 404, body: { error: `${source} connector is off` } };
  if (mode !== 'sim') {
    return {
      status: 503,
      body: { error: `${source} webhook secret is not configured; ${mode} mode relies on polling` },
    };
  }
  return null;
}

/** Deere's subscription handshake event. // doc-derived, confirm (field name and value) */
function isVerification(source: WebhookSource, payload: unknown): boolean {
  if (source !== 'deere' || !payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.eventTypeId === 'subscriptionVerification' || p.eventType === 'subscriptionVerification';
}

function eventIdOf(payload: unknown, sha: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    for (const k of ['eventId', 'id', 'messageId']) {
      const v = p[k];
      if ((typeof v === 'string' && v) || typeof v === 'number') return String(v);
    }
  }
  return sha;
}

export async function handleWebhook(ex: Executor, input: WebhookInput): Promise<WebhookOutcome> {
  const { source, mode, body, headers, now } = input;
  const refused = webhookModeRefusal(source, mode);
  if (refused) return refused;
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: 'body over 4 MB' } };
  }
  const h = SIGNATURE_HEADERS[source];
  if (
    !verifyWebhookSignature(
      input.simSecret,
      body,
      headers.get(h.timestamp),
      headers.get(h.signature),
      now,
    )
  ) {
    return { status: 401, body: { error: 'bad or missing webhook signature' } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'body must be JSON' } };
  }
  if (isVerification(source, payload)) return { status: 200, body: { ok: true, verified: true } };

  const sha = createHash('sha256').update(body).digest('hex');
  const landed = await exec(
    ex,
    `insert into ingest.raw_events (source, stream, external_id, payload, sha256)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (source, stream, external_id, sha256) do nothing`,
    [source, WEBHOOK_STREAM, eventIdOf(payload, sha), body, sha],
  );
  const nudged = await exec(
    ex,
    `update ingest.sync_state set next_run_at = now(), updated_at = now()
      where source = $1 and stream = any($2::text[])`,
    [source, [...WEBHOOK_NUDGES[source]]],
  );
  return {
    status: 200,
    body: { ok: true, landed: landed.rowCount === 1, nudged: nudged.rowCount },
  };
}
