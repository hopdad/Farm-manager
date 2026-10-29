/**
 * Operator PINs (D8; docs/contracts-m1.md §4 "PIN hashing"): node:crypto scrypt with a per-user
 * random salt, compared with timingSafeEqual; no dependency. Lockout state lives in the row
 * (farm.app_users.failed_pins / locked_until, ./store.ts), never in memory.
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url>`, so the cost can be raised
 * later without invalidating existing PINs (verify reads the parameters from the hash).
 *
 * A 4-digit PIN has only 10 000 values; what protects it is the lockout (PIN_RULES: 5 tries,
 * then 15 minutes), not the hash. The hash keeps a copied database from handing out PINs
 * directly. Setting a PIN also refuses the guessable ones (1111, 1234, 1212, ...).
 */
import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';
import { PIN_RULES } from './types';

const KEY_LEN = 32;
const SALT_LEN = 16;
/** N = 2^14, r = 8, p = 1: 16 MiB, a few tens of ms per check. */
const DEFAULT_COST = Object.freeze({ N: 1 << 14, r: 8, p: 1 });
/** Refuse absurd parameters read back from a row (CPU/memory exhaustion). */
const MAX_N = 1 << 17;

const PIN_RE = new RegExp(`^\\d{${PIN_RULES.minLength},${PIN_RULES.maxLength}}$`);

/** Digits only, of an allowed length (what a sign-in attempt must look like). */
export function isWellFormedPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_RE.test(pin);
}

/** Why `pin` can't be someone's new PIN, or null when it can. */
export function pinProblem(pin: unknown): string | null {
  if (!isWellFormedPin(pin)) {
    return `a PIN is ${PIN_RULES.minLength} to ${PIN_RULES.maxLength} digits`;
  }
  if (isGuessablePin(pin))
    return 'that PIN is too easy to guess (repeats or runs like 1111, 1234, 1212)';
  return null;
}

/** All one digit, a straight run up or down (1234, 9876), or a repeated pair (1212, 4545...). */
export function isGuessablePin(pin: string): boolean {
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((v, i) => v - (d[i] as number));
  if (steps.every((s) => s === 0)) return true;
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;
  if (pin.length % 2 === 0 && pin === (pin.slice(0, 2) as string).repeat(pin.length / 2))
    return true;
  return false;
}

function scryptAsync(pin: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmem = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024;

/** Hash a PIN for farm.app_users.pin_hash (call pinProblem first). */
export async function hashPin(pin: string): Promise<string> {
  if (!isWellFormedPin(pin)) throw new Error('not a PIN');
  const { N, r, p } = DEFAULT_COST;
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(pin, salt, { N, r, p, maxmem: maxmem(N, r) });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4] as string, 'base64url');
  const key = Buffer.from(parts[5] as string, 'base64url');
  const pow2 = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!pow2 || N > MAX_N || !Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4 || salt.length < 8 || key.length !== KEY_LEN) {
    return null;
  }
  return { N, r, p, salt, key };
}

/** Does `pin` match `stored`? Constant-time compare; false for a malformed hash or PIN. */
export async function verifyPin(pin: unknown, stored: string | null | undefined): Promise<boolean> {
  const h = stored ? parseHash(stored) : null;
  if (!h || !isWellFormedPin(pin)) {
    await burn();
    return false;
  }
  const got = await scryptAsync(pin, h.salt, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r) });
  return got.length === h.key.length && timingSafeEqual(got, h.key);
}

/**
 * Spend about as long as a real check, so "no such person" or "no PIN set" answers no faster
 * than "wrong PIN".
 */
export async function burn(): Promise<void> {
  const { N, r, p } = DEFAULT_COST;
  await scryptAsync('0000', Buffer.alloc(SALT_LEN), { N, r, p, maxmem: maxmem(N, r) });
}
