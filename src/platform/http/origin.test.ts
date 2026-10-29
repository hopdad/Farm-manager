import { describe, expect, test } from 'vitest';
import { isSameOriginRequest } from './origin';

const req = (headers: Record<string, string>) =>
  new Request('http://app.invalid/api/x', { method: 'POST', headers });

describe('isSameOriginRequest', () => {
  test('no Origin (curl, the clock, tests): allowed', () => {
    expect(isSameOriginRequest(req({ host: '192.168.1.20:3000' }))).toBe(true);
  });

  test('the page the request came from: the LAN address, localhost, a proxy host', () => {
    expect(
      isSameOriginRequest(req({ origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' })),
    ).toBe(true);
    expect(
      isSameOriginRequest(req({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        req({
          origin: 'https://farm.example.com',
          host: 'internal:3000',
          'x-forwarded-host': 'farm.example.com, edge',
        }),
      ),
    ).toBe(true);
  });

  test('another site, another port of the same address, opaque or garbage origins: refused', () => {
    expect(
      isSameOriginRequest(req({ origin: 'http://evil.example', host: '192.168.1.20:3000' })),
    ).toBe(false);
    expect(
      isSameOriginRequest(req({ origin: 'http://192.168.1.20:8080', host: '192.168.1.20:3000' })),
    ).toBe(false);
    expect(
      isSameOriginRequest(req({ origin: 'http://localhost:3000', host: '192.168.1.20:3000' })),
    ).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'null', host: 'a:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'garbage', host: 'a:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'http://a:3000' }))).toBe(false);
  });
});
