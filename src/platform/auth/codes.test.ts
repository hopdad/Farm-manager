/** One-time codes: enrollment code shape and normalization, hashing, the owner setup code. */
import { describe, expect, test } from 'vitest';
import {
  CODE_ALPHABET,
  formatEnrollCode,
  hashCode,
  isOwnerSetupCode,
  looksLikeResetCode,
  newEnrollCode,
  newOwnerResetCode,
  normalizeEnrollCode,
  ownerSetupCode,
} from './codes';

const SECRET = 'codes-test-secret-0123456789abcdef-xyz';

describe('enrollment codes', () => {
  test('10 Crockford base-32 characters, random', () => {
    const codes = new Set(Array.from({ length: 200 }, newEnrollCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(CODE_ALPHABET).toHaveLength(32);
  });

  test('typed forgivingly: case, dashes, spaces, O/0 and I/L/1', () => {
    expect(formatEnrollCode('K7QD2M9XPA')).toBe('K7QD2-M9XPA');
    expect(normalizeEnrollCode('k7qd2-m9xpa')).toBe('K7QD2M9XPA');
    expect(normalizeEnrollCode(' K7QD2 M9XPA ')).toBe('K7QD2M9XPA');
    expect(normalizeEnrollCode('O1LIX-00000')).toBe('0111X00000');
    for (const bad of [
      '',
      'K7QD2',
      'K7QD2M9XPAA',
      'K7QD2-M9XP!',
      'K7QD2-M9XPU',
      null,
      42,
      'x'.repeat(100),
    ]) {
      expect(normalizeEnrollCode(bad)).toBeNull();
    }
  });

  test('only a keyed hash is stored; purposes do not collide', () => {
    const h = hashCode(SECRET, 'enroll', 'K7QD2M9XPA');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashCode(SECRET, 'enroll', 'K7QD2M9XPA'));
    expect(h).not.toBe(hashCode('another-secret-0123456789abcdef-xyz', 'enroll', 'K7QD2M9XPA'));
    expect(h).not.toBe(hashCode(SECRET, 'owner-reset', 'K7QD2M9XPA'));
  });
});

describe('owner codes', () => {
  test('the setup code is per install and checked in constant time', () => {
    const code = ownerSetupCode(SECRET);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ownerSetupCode(SECRET)).toBe(code);
    expect(isOwnerSetupCode(SECRET, code)).toBe(true);
    expect(isOwnerSetupCode(SECRET, `${code}x`)).toBe(false);
    expect(isOwnerSetupCode('another-secret-0123456789abcdef-xyz', code)).toBe(false);
    expect(isOwnerSetupCode(SECRET, undefined)).toBe(false);
  });

  test('reset codes are random and have one shape', () => {
    const a = newOwnerResetCode();
    expect(looksLikeResetCode(a)).toBe(true);
    expect(newOwnerResetCode()).not.toBe(a);
    expect(looksLikeResetCode('short')).toBe(false);
    expect(looksLikeResetCode(`${a}'`)).toBe(false);
  });
});
