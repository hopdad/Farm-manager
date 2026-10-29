import { describe, expect, test } from 'vitest';
import {
  isWebhookSource,
  signWebhook,
  simWebhookSecret,
  verifyWebhookSignature,
  webhookModeRefusal,
} from './webhooks';

describe('webhook signatures', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"eventId":"e1","eventType":"VehicleLocationUpdated"}';
  const secret = simWebhookSecret('s'.repeat(40), 'samsara');

  test('accepts the right signature (also in a comma list), rejects tampering and replays', () => {
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
