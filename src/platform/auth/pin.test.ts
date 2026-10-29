/** Operator PINs: format rules, guessable PINs refused, scrypt hashing and verification. */

import { scryptSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  hashPin,
  isGuessablePin,
  isWellFormedPin,
  needsRehash,
  pinPepper,
  pinProblem,
  verifyPin,
} from './pin';
import { LOCKOUT_MAX_MINUTES, lockoutMinutesAfter } from './store';
import { PIN_RULES } from './types';

describe('PIN rules', () => {
  test('4 to 8 digits only', () => {
    for (const ok of ['2580', '4071', '90817263']) expect(isWellFormedPin(ok)).toBe(true);
    for (const bad of ['123', '123456789', '12a4', ' 4071', '4071\n', '', 4071, null]) {
      expect(isWellFormedPin(bad)).toBe(false);
    }
    expect(PIN_RULES.minLength).toBe(4);
    expect(PIN_RULES.maxLength).toBe(8);
  });

  test('guessable PINs are refused when set', () => {
    for (const weak of [
      '1111',
      '0000',
      '1234',
      '4321',
      '0123',
      '9876',
      '1212',
      '454545',
      '12345678',
    ]) {
      expect(isGuessablePin(weak), weak).toBe(true);
      expect(pinProblem(weak)).toMatch(/too easy/);
    }
    for (const fine of ['4071', '2580', '1357', '9024', '112233']) {
      expect(pinProblem(fine), fine).toBeNull();
    }
    expect(pinProblem('12')).toMatch(/4 to 8 digits/);
  });
});

describe('hashing', () => {
  // Unit tests pass the pepper (the app derives it from SESSION_SECRET, which they don't load).
  const PEPPER = pinPepper('pin-test-secret-0123456789abcdef-xyz');
  const OTHER = pinPepper('another-install-secret-0123456789abcd');

  test('peppered scrypt with a random salt: same PIN, different hashes; both verify', async () => {
    const a = await hashPin('4071', PEPPER);
    const b = await hashPin('4071', PEPPER);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt-p1\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPin('4071', a, PEPPER)).toBe(true);
    expect(await verifyPin('4071', b, PEPPER)).toBe(true);
    expect(await verifyPin('4072', a, PEPPER)).toBe(false);
    expect(await verifyPin('40710', a, PEPPER)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  test("a copied hash is useless without this install's secret", async () => {
    const h = await hashPin('4071', PEPPER);
    expect(await verifyPin('4071', h, OTHER)).toBe(false);
    // Trying all 10 000 four-digit PINs without the pepper finds nothing (spot check).
    for (const guess of ['4071', '0000', '9999']) {
      expect(await verifyPin(guess, h.replace('scrypt-p1', 'scrypt'), OTHER)).toBe(false);
    }
  });

  test('a hash from before the pepper still verifies and asks to be rewritten', async () => {
    // scrypt of the bare PIN, as written before: N=2^14, r=8, p=1, a fixed salt.
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync('4071', salt, 32, { N: 1 << 14, r: 8, p: 1 });
    const legacy = [
      'scrypt',
      16384,
      8,
      1,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
    expect(needsRehash(legacy)).toBe(true);
    expect(await verifyPin('4071', legacy, PEPPER)).toBe(true);
    expect(await verifyPin('4072', legacy, PEPPER)).toBe(false);
  });

  test('malformed hashes and PINs never verify (and never throw)', async () => {
    const h = await hashPin('9024', PEPPER);
    for (const stored of [
      null,
      undefined,
      '',
      'plain',
      h.replace('scrypt-p1', 'bcrypt'),
      h.replace('$16384$', '$999999999$'),
      h.replace('$16384$', '$1000$'),
      h.slice(0, -4),
    ]) {
      expect(await verifyPin('9024', stored, PEPPER)).toBe(false);
    }
    expect(await verifyPin('90x4', h, PEPPER)).toBe(false);
    expect(await verifyPin(9024, h, PEPPER)).toBe(false);
  });

  test('hashPin refuses a non-PIN', async () => {
    await expect(hashPin('abcd', PEPPER)).rejects.toThrow();
  });
});

describe('lockout lengths', () => {
  test('every 5th wrong PIN locks: 15 min, then doubling up to a day', () => {
    expect(PIN_RULES.maxFailures).toBe(5);
    expect(PIN_RULES.lockoutMinutes).toBe(15);
    expect([0, 1, 4, 6, 9].map(lockoutMinutesAfter)).toEqual([0, 0, 0, 0, 0]);
    expect([5, 10, 15, 20, 25, 30, 35, 40, 500].map(lockoutMinutesAfter)).toEqual([
      15,
      30,
      60,
      120,
      240,
      480,
      960,
      LOCKOUT_MAX_MINUTES,
      LOCKOUT_MAX_MINUTES,
    ]);
  });
});
