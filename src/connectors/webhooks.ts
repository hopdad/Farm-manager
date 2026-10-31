/**
 * Vendor webhooks only NUDGE (plan §5): answer the verification handshake, land the body in
 * ingest.raw_events (stream 'webhook'), set the source's streams due now
 * (sync_state.next_run_at = now()) and acknowledge. Nothing is processed inline; the next
 * clock tick runs the stream (and M1 processes the webhook inbox).
 *
 * Each vendor's own documented scheme (checked against the official docs Oct 30, 2026):
 *   samsara  X-Samsara-Signature: `v1=<hex HMAC-SHA256(base64-decoded secret, "v1:<ts>:<body>")>`
 *            with X-Samsara-Timestamp (Samsara webhooks 2.0; confirmed). The 5-minute window is
 *            ours (Samsara sets none). Answers 200 with a small JSON body.
 *   motive   X-KT-Webhook-Signature: `<hex HMAC-SHA1(secret as given, raw body)>`, no timestamp
 *            and no prefix (Motive Webhooks V1 and v2); a mismatch answers 403 (Motive then stops
 *            retrying). Enabling a webhook sends the literal body `[vehicle_location_updated]`
 *            (not JSON), which must get a 200. Events are deduped by `action` + `id`.
 *   deere    NO signature (Deere's Data Subscription Service; `x-deere-signature` is its eTag
 *            header): the `Authorization` header carries the value set once with
 *            PATCH /eventSubscriptionDelivery, and/or each event carries its subscription's
 *            `token`. The body is a JSON ARRAY of events; the endpoint answers 204 No Content
 *            within 5 s (the `subscriptionVerification` event included), or the subscription is
 *            refused. There is no location, breadcrumb, equipment or engine-hours event: a Deere
 *            webhook nudges fields, flags and operations only (DEERE_EVENT_NUDGES).
 * In sim mode the secret is simWebhookSecret(SESSION_SECRET, source): per install, so nobody on
 * the LAN can forge a "signed" body from constants in the repo (the stand-in derives the same
 * secret from the same config once it sends webhooks; Deere's Authorization value and token are
 * that string too). Real secrets need config keys that don't exist yet (SAMSARA_WEBHOOK_SECRET,
 * …), and every vendor needs a public HTTPS endpoint (MD), so sandbox/live webhooks are refused
 * (503) instead of being accepted unsigned. The route refuses off/sandbox/live before it reads
 * the body.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type Executor, exec } from '../db/exec';
import type { Mode } from './types';

export const WEBHOOK_SOURCES = ['samsara', 'deere', 'motive'] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

/** ingest.raw_events.stream of landed webhook bodies (the webhook inbox). */
export const WEBHOOK_STREAM = 'webhook';

/**
 * Deere event types → the deere streams they make due (Deere's documented event types: no
 * location or equipment events). Other types (heartbeat, workPlan, …) nudge nothing.
 */
export const DEERE_EVENT_NUDGES: Readonly<Record<string, readonly string[]>> = {
  fieldOperation: ['operations'],
  field: ['fields'],
  boundary: ['fields'],
  farm: ['fields'],
  client: ['fields'],
  flag: ['flags'],
  flagCategory: ['flags'],
};

/** sync_state streams a webhook from each source may make due (Deere: by event type, above). */
export const WEBHOOK_NUDGES: Record<WebhookSource, readonly string[]> = {
  samsara: ['positions', 'stats'],
  deere: ['fields', 'flags', 'operations'],
  motive: ['positions', 'faults'],
};

/** The sim-mode signing secret of `source` (base64), derived from this install's SESSION_SECRET. */
export function simWebhookSecret(sessionSecret: string, source: WebhookSource): string {
  return createHmac('sha256', sessionSecret).update(`sim-webhook:${source}`).digest('base64');
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;

export function isWebhookSource(s: string): s is WebhookSource {
  return (WEBHOOK_SOURCES as readonly string[]).includes(s);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Samsara: `v1=<hex>` for a body at `timestamp` (unix seconds). Used by the stand-in and the tests. */
export function signWebhook(secretB64: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', Buffer.from(secretB64, 'base64'))
    .update(`v1:${timestamp}:${body}`)
    .digest('hex');
  return `v1=${mac}`;
}

/** Samsara's check: the timestamp within the window and one of the (comma-listed) signatures. */
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
  const want = signWebhook(secretB64, timestamp, body);
  return signature
    .split(',')
    .map((s) => s.trim())
    .some((got) => safeEqual(got, want));
}

/** Motive: X-KT-Webhook-Signature = hex HMAC-SHA1 of the raw body, keyed by the secret as given. */
export function signMotiveWebhook(secret: string, body: string): string {
  return createHmac('sha1', secret).update(body).digest('hex');
}

export function verifyMotiveSignature(
  secret: string,
  body: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  return safeEqual(signature.trim().toLowerCase(), signMotiveWebhook(secret, body));
}

export interface WebhookInput {
  source: WebhookSource;
  mode: Mode;
  body: string;
  headers: Headers;
  now: Date;
  /**
   * simWebhookSecret(cfg.SESSION_SECRET, source): Samsara's signing key, Motive's shared secret,
   * Deere's Authorization value and subscription token.
   */
  simSecret: string;
}

export interface WebhookOutcome {
  status: number;
  /** JSON body; null = no body (Deere's 204). */
  body: Record<string, unknown> | null;
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

/** Deere's events: the body is an array (one object is read as a list of one). */
function deereEvents(payload: unknown): Record<string, unknown>[] | null {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  if (!list.length) return null;
  if (!list.every((e) => e && typeof e === 'object' && !Array.isArray(e))) return null;
  return list as Record<string, unknown>[];
}

/** Deere: the Authorization header is the configured value, or every event carries the token. */
function deereAuthorized(
  headers: Headers,
  events: readonly Record<string, unknown>[],
  secret: string,
): boolean {
  const auth = headers.get('authorization');
  if (auth && safeEqual(auth.trim(), secret)) return true;
  return events.every((e) => typeof e.token === 'string' && safeEqual(e.token, secret));
}

function eventIdOf(source: WebhookSource, payload: unknown, sha: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    if (source === 'motive' && typeof p.action === 'string' && p.id !== undefined) {
      return `${p.action}:${String(p.id)}`;
    }
    for (const k of ['eventId', 'id', 'messageId']) {
      const v = p[k];
      if ((typeof v === 'string' && v) || typeof v === 'number') return String(v);
    }
  }
  // Deere events carry no id (and arrive in batches): the body's hash dedupes a redelivery.
  return sha;
}

/** The streams one webhook body makes due. */
function nudgesOf(source: WebhookSource, payload: unknown): readonly string[] {
  if (source !== 'deere') return WEBHOOK_NUDGES[source];
  const streams = new Set<string>();
  for (const e of deereEvents(payload) ?? []) {
    const type = typeof e.eventTypeId === 'string' ? e.eventTypeId : '';
    for (const s of DEERE_EVENT_NUDGES[type] ?? []) streams.add(s);
  }
  return [...streams];
}

const ack = (source: WebhookSource, extra: Record<string, unknown>): WebhookOutcome =>
  source === 'deere' ? { status: 204, body: null } : { status: 200, body: { ok: true, ...extra } };

export async function handleWebhook(ex: Executor, input: WebhookInput): Promise<WebhookOutcome> {
  const { source, mode, body, headers, now } = input;
  const refused = webhookModeRefusal(source, mode);
  if (refused) return refused;
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: 'body over 4 MB' } };
  }
  if (source === 'samsara') {
    const ok = verifyWebhookSignature(
      input.simSecret,
      body,
      headers.get('x-samsara-timestamp'),
      headers.get('x-samsara-signature'),
      now,
    );
    if (!ok) return { status: 401, body: { error: 'bad or missing webhook signature' } };
  }
  if (source === 'motive') {
    if (!verifyMotiveSignature(input.simSecret, body, headers.get('x-kt-webhook-signature'))) {
      return { status: 403, body: { error: 'bad or missing webhook signature' } };
    }
    // Enabling a webhook (or changing its URL or secret) posts this literal, non-JSON body.
    if (/^\[\s*[a-z_]+\s*\]$/.test(body.trim())) return ack(source, { verified: true });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'body must be JSON' } };
  }
  if (source === 'deere') {
    const events = deereEvents(payload);
    if (!events) return { status: 400, body: { error: 'body must be a JSON array of events' } };
    if (!deereAuthorized(headers, events, input.simSecret)) {
      return { status: 401, body: { error: 'bad or missing Authorization or event token' } };
    }
    // The subscription handshake: acknowledged, never landed.
    if (events.every((e) => e.eventTypeId === 'subscriptionVerification')) return ack(source, {});
  }

  const sha = createHash('sha256').update(body).digest('hex');
  const landed = await exec(
    ex,
    `insert into ingest.raw_events (source, stream, external_id, payload, sha256)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (source, stream, external_id, sha256) do nothing`,
    [source, WEBHOOK_STREAM, eventIdOf(source, payload, sha), body, sha],
  );
  const streams = nudgesOf(source, payload);
  const nudged = streams.length
    ? await exec(
        ex,
        `update ingest.sync_state set next_run_at = now(), updated_at = now()
          where source = $1 and stream = any($2::text[])`,
        [source, [...streams]],
      )
    : { rowCount: 0 };
  return ack(source, { landed: landed.rowCount === 1, nudged: nudged.rowCount });
}
