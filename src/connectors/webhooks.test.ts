import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  isWebhookSource,
  signMotiveWebhook,
  signWebhook,
  simWebhookSecret,
  verifyMotiveSignature,
  verifyWebhookSignature,
  webhookModeRefusal,
} from './webhooks';

describe('webhook signatures', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"eventId":"e1","eventType":"VehicleLocationUpdated"}';
  const secret = simWebhookSecret('s'.repeat(40), 'samsara');

  test('Samsara: the right signature (also in a comma list); tampering and replays fail', () => {
    const sig = signWebhook(secret, ts, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, ts, sig, now)).toBe(true);
    expect(verifyWebhookSignature(secret, body, ts, `v1=00, ${sig}`, now)).toBe(true);
    expect(verifyWebhookSignature(secret, `${body} `, ts, sig, now)).toBe(false);
    expect(
      verifyWebhookSignature(simWebhookSecret('s'.repeat(40), 'deere'), body, ts, sig, now),
    ).toBe(false);
    expect(verifyWebhookSignature(secret, body, null, sig, now)).toBe(false);
    const late = new Date(now.getTime() + 301_000);
    expect(verifyWebhookSignature(secret, body, ts, sig, late)).toBe(false);
  });

  test("Motive: hex HMAC-SHA1 of the raw body with the secret as given (the docs' own example)", () => {
    // developer-docs.gomotive.com/reference/overview-company-webhooks: this key and body give
    // this signature (HMAC-SHA1, hex; no timestamp, no prefix).
    const docKey = 'd9d36bea41c44ae49d1bfc4a48ba2abe';
    const docBody = '["fault_code_closed"]';
    expect(signMotiveWebhook(docKey, docBody)).toBe('f04a8386a21a6cba0447024e83b3f0983352bb72');
    expect(verifyMotiveSignature(docKey, docBody, 'F04A8386A21A6CBA0447024E83B3F0983352BB72')).toBe(
      true,
    );
    expect(verifyMotiveSignature(docKey, `${docBody} `, signMotiveWebhook(docKey, docBody))).toBe(
      false,
    );
    expect(verifyMotiveSignature(docKey, docBody, null)).toBe(false);
    // Not Samsara's scheme: an HMAC-SHA256 never verifies.
    const sha256 = createHmac('sha256', docKey).update(docBody).digest('hex');
    expect(verifyMotiveSignature(docKey, docBody, sha256)).toBe(false);
  });

  test('sim secrets are per install (SESSION_SECRET) and per source', () => {
    expect(simWebhookSecret('a'.repeat(40), 'samsara')).not.toBe(
      simWebhookSecret('b'.repeat(40), 'samsara'),
    );
    expect(Buffer.from(secret, 'base64')).toHaveLength(32);
  });

  test('modes that take no webhooks are refused up front', () => {
    expect(webhookModeRefusal('samsara', 'sim')).toBeNull();
    expect(webhookModeRefusal('samsara', 'off')?.status).toBe(404);
    expect(webhookModeRefusal('deere', 'live')?.status).toBe(503);
    expect(webhookModeRefusal('deere', 'sandbox')?.status).toBe(503);
  });

  test('sources', () => {
    expect(isWebhookSource('deere')).toBe(true);
    expect(isWebhookSource('qbo')).toBe(false);
  });
});
