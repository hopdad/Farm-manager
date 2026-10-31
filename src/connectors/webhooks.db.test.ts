/**
 * Webhooks only nudge (plan §5): verify (each vendor's documented scheme), land in
 * ingest.raw_events (deduped), make the source's streams due, acknowledge; Deere's verification
 * handshake and Motive's enable POST are answered without landing.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import {
  handleWebhook,
  signMotiveWebhook,
  signWebhook,
  simWebhookSecret,
  WEBHOOK_STREAM,
  type WebhookSource,
} from './webhooks';

const t = setupTestDb(import.meta.url);
const now = new Date();
const ts = String(Math.floor(now.getTime() / 1000));
const SESSION_SECRET = 'q'.repeat(48);
const simSecret = (source: WebhookSource) => simWebhookSecret(SESSION_SECRET, source);

function signed(body: string): Headers {
  return new Headers({
    'x-samsara-timestamp': ts,
    'x-samsara-signature': signWebhook(simSecret('samsara'), ts, body),
  });
}

const input = (source: WebhookSource, body: string, headers: Headers, mode = 'sim' as const) => ({
  source,
  mode,
  body,
  headers,
  now,
  simSecret: simSecret(source),
});

describe('webhooks', () => {
  test('lands once, nudges the streams, never processes', async () => {
    const { pool } = t();
    await pool.query(`select app.ensure_stream('samsara', 'positions', 'sim')`);
    await pool.query(
      `update ingest.sync_state set next_run_at = now() + interval '1 hour' where source = 'samsara'`,
    );
    const body = JSON.stringify({
      eventId: 'evt-1',
      eventType: 'VehicleLocationUpdated',
      data: {},
    });
    const req = input('samsara', body, signed(body));
    expect(await handleWebhook(pool, req)).toEqual({
      status: 200,
      body: { ok: true, landed: true, nudged: 1 },
    });
    expect((await handleWebhook(pool, req)).body).toMatchObject({ landed: false }); // replay
    const raw = await pool.query(
      `select external_id, status, payload->>'eventType' as type from ingest.raw_events where stream = $1`,
      [WEBHOOK_STREAM],
    );
    expect(raw.rows).toEqual([
      { external_id: 'evt-1', status: 'pending', type: 'VehicleLocationUpdated' },
    ]);
    const due = await pool.query(
      `select next_run_at <= now() as due from ingest.sync_state where source = 'samsara' and stream = 'positions'`,
    );
    expect(due.rows[0].due).toBe(true);
  });

  test('bad signatures, non-JSON, off and live modes are refused', async () => {
    const { pool } = t();
    const body = '{"eventId":"evt-2"}';
    const bad = new Headers({ 'x-samsara-timestamp': ts, 'x-samsara-signature': 'v1=00' });
    expect((await handleWebhook(pool, input('samsara', body, bad))).status).toBe(401);
    const junk = 'not json';
    expect((await handleWebhook(pool, input('samsara', junk, signed(junk)))).status).toBe(400);
    expect(
      (await handleWebhook(pool, { ...input('samsara', body, bad), mode: 'off' })).status,
    ).toBe(404);
    expect(
      (await handleWebhook(pool, { ...input('samsara', body, bad), mode: 'live' })).status,
    ).toBe(503);
  });

  test("Deere: an array of events, the configured Authorization value or each event's token, 204", async () => {
    const { pool } = t();
    await pool.query(`select app.ensure_stream('deere', 'operations', 'sim')`);
    await pool.query(`select app.ensure_stream('deere', 'locations', 'sim')`);
    await pool.query(
      `update ingest.sync_state set next_run_at = now() + interval '1 hour' where source = 'deere'`,
    );
    const event = {
      clientKey: 'sim-deere-client',
      eventTypeId: 'fieldOperation',
      targetResource: 'https://sandboxapi.deere.com/platform/fieldOperations/op-1',
      metadata: [{ key: 'orgId', value: 'org-home' }],
    };
    // The handshake: answered 204, never landed (with the Authorization header).
    const verify = JSON.stringify([{ ...event, eventTypeId: 'subscriptionVerification' }]);
    const auth = new Headers({ authorization: simSecret('deere') });
    expect(await handleWebhook(pool, input('deere', verify, auth))).toEqual({
      status: 204,
      body: null,
    });
    // An event with its subscription token (no Authorization header) lands and nudges
    // operations, never locations (Deere has no location events).
    const body = JSON.stringify([{ ...event, token: simSecret('deere') }]);
    expect(await handleWebhook(pool, input('deere', body, new Headers()))).toEqual({
      status: 204,
      body: null,
    });
    const due = await pool.query(
      `select stream, next_run_at <= now() as due from ingest.sync_state where source = 'deere' order by stream`,
    );
    expect(due.rows).toEqual([
      { stream: 'locations', due: false },
      { stream: 'operations', due: true },
    ]);
    // Neither the right header nor the right token: refused. HMAC headers mean nothing to Deere.
    const forged = new Headers({ 'x-deere-signature': 'v1=00', authorization: 'Bearer nope' });
    expect(
      (await handleWebhook(pool, input('deere', JSON.stringify([event]), forged))).status,
    ).toBe(401);
    const raw = await pool.query(
      `select count(*)::int as n from ingest.raw_events where source = 'deere'`,
    );
    expect(raw.rows[0].n).toBe(1);
  });

  test('Motive: X-KT-Webhook-Signature (HMAC-SHA1), the enable POST, 403 on a mismatch', async () => {
    const { pool } = t();
    const secret = simSecret('motive');
    const sig = (b: string) =>
      new Headers({ 'x-kt-webhook-signature': signMotiveWebhook(secret, b) });
    const hello = '[vehicle_location_updated]';
    expect(await handleWebhook(pool, input('motive', hello, sig(hello)))).toEqual({
      status: 200,
      body: { ok: true, verified: true },
    });
    const body = JSON.stringify({ action: 'fault_code_opened', id: 77, code: 'P0217' });
    expect((await handleWebhook(pool, input('motive', body, sig(body)))).body).toMatchObject({
      landed: true,
    });
    const raw = await pool.query(
      `select external_id from ingest.raw_events where source = 'motive' and stream = $1`,
      [WEBHOOK_STREAM],
    );
    expect(raw.rows).toEqual([{ external_id: 'fault_code_opened:77' }]);
    expect((await handleWebhook(pool, input('motive', body, sig(`${body} `)))).status).toBe(403);
  });
});
