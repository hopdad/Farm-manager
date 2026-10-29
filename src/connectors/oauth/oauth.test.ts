import { describe, expect, test } from 'vitest';
import { decryptSecret, encryptSecret, TokenCryptoError, tokenKey } from './crypto';
import { clearStateCookie, readCookie, stateCookie, stateCookieName, statesMatch } from './flow';
import { MemoryTokenStore } from './memory-store';
import { OAuthReconnectError, type OAuthTokens } from './token-store';

const KEY = tokenKey('0f'.repeat(32));

describe('token encryption', () => {
  test('round-trips; the ciphertext hides the token and is bound to its row', () => {
    const ct = encryptSecret(KEY, '{"a":"access-123"}', 'deere|');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('access-123');
    expect(decryptSecret(KEY, ct, 'deere|')).toBe('{"a":"access-123"}');
    expect(() => decryptSecret(KEY, ct, 'qbo|realm')).toThrow(TokenCryptoError);
    expect(() => decryptSecret(tokenKey('1f'.repeat(32)), ct, 'deere|')).toThrow(TokenCryptoError);
    expect(encryptSecret(KEY, 'x', 'a')).not.toBe(encryptSecret(KEY, 'x', 'a')); // fresh IV
  });

  test('a missing key is a fix-it error', () => {
    expect(() => tokenKey(undefined)).toThrow(/TOKEN_ENC_KEY.*pnpm env:init/);
    expect(() => tokenKey('abc')).toThrow(TokenCryptoError);
  });
});

describe('OAuth state cookie', () => {
  test('Set-Cookie attributes; Secure follows PUBLIC_URL', () => {
    const c = stateCookie('deere', 'abc', false);
    expect(c).toBe(
      'farm_oauth_deere=abc; Path=/api/oauth/deere; Max-Age=600; HttpOnly; SameSite=Lax',
    );
    expect(stateCookie('deere', 'abc', true).endsWith('; Secure')).toBe(true);
    expect(clearStateCookie('deere', false)).toContain('Max-Age=0');
  });

  test('read and compare', () => {
    const header = `other=1; ${stateCookieName('deere')}=s3cr3t; x=y`;
    expect(readCookie(header, 'farm_oauth_deere')).toBe('s3cr3t');
    expect(readCookie(null, 'farm_oauth_deere')).toBeNull();
    expect(statesMatch('s3cr3t', 's3cr3t')).toBe(true);
    expect(statesMatch('s3cr3t', 's3cr3x')).toBe(false);
    expect(statesMatch(null, 'a')).toBe(false);
  });
});

describe('MemoryTokenStore (same rules as the DB store)', () => {
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  const tokens = (n: number, expiresInMs: number): OAuthTokens => ({
    accessToken: `a${n}`,
    refreshToken: `r${n}`,
    tokenType: 'Bearer',
    expiresAt: new Date(t0 + expiresInMs),
    refreshExpiresAt: null,
    scopes: [],
  });

  test('ten concurrent callers on an expired token refresh exactly once', async () => {
    const store = new MemoryTokenStore('deere', tokens(1, 10_000), { now: () => new Date(t0) });
    let calls = 0;
    const refresher = async (rt: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      expect(rt).toBe('r1');
      return tokens(2, 300_000);
    };
    const got = await Promise.all(Array.from({ length: 10 }, () => store.accessToken(refresher)));
    expect(new Set(got)).toEqual(new Set(['a2']));
    expect(calls).toBe(1);
  });

  test('invalid_grant drops the grant and asks for re-consent', async () => {
    const store = new MemoryTokenStore('deere', tokens(1, 0), { now: () => new Date(t0) });
    const dead = async () => {
      throw Object.assign(new Error('HTTP 400'), { oauthError: 'invalid_grant' });
    };
    await expect(store.accessToken(dead)).rejects.toBeInstanceOf(OAuthReconnectError);
    expect(store.tokens).toBeNull();
    expect(await store.accessToken(dead)).toBeNull();
  });
});
