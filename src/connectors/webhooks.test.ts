import { describe, expect, test } from 'vitest';
import {
  isWebhookSource,
  SIM_WEBHOOK_SECRETS,
  signWebhook,
  verifyWebhookSignature,
} from './webhooks';

describe('webhook signatures', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"eventId":"e1","eventType":"VehicleLocationUpdated"}';
  const secret = SIM_WEBHOOK_SECRETS.samsara;

  test('accepts the right signature (also in a comma list), rejects tampering and replays', () => {
    const sig = signWebhook(secret, ts, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, ts, sig, now)).toBe(true);
    expect(verifyWebhookSignature(secret, body, ts, `v1=00, ${sig}`, now)).toBe(true);
    expect(verifyWebhookSignature(secret, `${body} `, ts, sig, now)).toBe(false);
    expect(verifyWebhookSignature(SIM_WEBHOOK_SECRETS.deere, body, ts, sig, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null, sig, now)).toBe(false);
    const late = new Date(now.getTime() + 301_000);
    expect(verifyWebhookSignature(secret, body, ts, sig, late)).toBe(false);
  });

  test('sources', () => {
    expect(isWebhookSource('deere')).toBe(true);
    expect(isWebhookSource('qbo')).toBe(false);
  });
});
