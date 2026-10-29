/**
 * Webhooks only nudge (plan §5): verify, land in ingest.raw_events (deduped), make the
 * source's streams due, answer 200; Deere's verification handshake is answered as is.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import { handleWebhook, SIM_WEBHOOK_SECRETS, signWebhook, WEBHOOK_STREAM } from './webhooks';

const t = setupTestDb(import.meta.url);
const now = new Date();
const ts = String(Math.floor(now.getTime() / 1000));

function signed(source: 'samsara' | 'deere', body: string): Headers {
  const prefix = source === 'samsara' ? 'x-samsara' : 'x-deere';
  return new Headers({
    [`${prefix}-timestamp`]: ts,
    [`${prefix}-signature`]: signWebhook(SIM_WEBHOOK_SECRETS[source], ts, body),
  });
}

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
    const input = {
      source: 'samsara' as const,
      mode: 'sim' as const,
      body,
      headers: signed('samsara', body),
      now,
    };
    expect(await handleWebhook(pool, input)).toEqual({
      status: 200,
      body: { ok: true, landed: true, nudged: 1 },
    });
    expect((await handleWebhook(pool, input)).body).toMatchObject({ landed: false }); // replay
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
    expect(
      (await handleWebhook(pool, { source: 'samsara', mode: 'sim', body, headers: bad, now }))
        .status,
    ).toBe(401);
    const junk = 'not json';
    expect(
      (
        await handleWebhook(pool, {
          source: 'samsara',
          mode: 'sim',
          body: junk,
          headers: signed('samsara', junk),
          now,
        })
      ).status,
    ).toBe(400);
    expect(
      (await handleWebhook(pool, { source: 'samsara', mode: 'off', body, headers: bad, now }))
        .status,
    ).toBe(404);
    expect(
      (await handleWebhook(pool, { source: 'samsara', mode: 'live', body, headers: bad, now }))
        .status,
    ).toBe(503);
  });

  test("Deere's subscriptionVerification is answered without landing", async () => {
    const { pool } = t();
    const body = JSON.stringify({ eventTypeId: 'subscriptionVerification', id: 'v-1' });
    const out = await handleWebhook(pool, {
      source: 'deere',
      mode: 'sim',
      body,
      headers: signed('deere', body),
      now,
    });
    expect(out).toEqual({ status: 200, body: { ok: true, verified: true } });
    const raw = await pool.query(
      `select count(*)::int as n from ingest.raw_events where source = 'deere'`,
    );
    expect(raw.rows[0].n).toBe(0);
  });
});
