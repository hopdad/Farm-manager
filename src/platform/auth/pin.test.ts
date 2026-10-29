/** Operator PINs: format rules, guessable PINs refused, scrypt hashing and verification. */
import { describe, expect, test } from 'vitest';
import { hashPin, isGuessablePin, isWellFormedPin, pinProblem, verifyPin } from './pin';
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
  test('scrypt with a random salt: same PIN, different hashes; both verify', async () => {
    const a = await hashPin('4071');
    const b = await hashPin('4071');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPin('4071', a)).toBe(true);
    expect(await verifyPin('4071', b)).toBe(true);
    expect(await verifyPin('4072', a)).toBe(false);
    expect(await verifyPin('40710', a)).toBe(false);
  });

  test('malformed hashes and PINs never verify (and never throw)', async () => {
    const h = await hashPin('9024');
    for (const stored of [
      null,
      undefined,
      '',
      'plain',
      h.replace('scrypt', 'bcrypt'),
      h.replace('$16384$', '$999999999$'),
      h.replace('$16384$', '$1000$'),
      h.slice(0, -4),
    ]) {
      expect(await verifyPin('9024', stored)).toBe(false);
    }
    expect(await verifyPin('90x4', h)).toBe(false);
    expect(await verifyPin(9024, h)).toBe(false);
  });

  test('hashPin refuses a non-PIN', async () => {
    await expect(hashPin('abcd')).rejects.toThrow();
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
