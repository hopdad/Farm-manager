/**
 * Operator PINs (D8; docs/contracts-m1.md §4 "PIN hashing"): node:crypto scrypt with a per-user
 * random salt, compared with timingSafeEqual; no dependency. Lockout state lives in the row
 * (farm.app_users.failed_pins / locked_until, ./store.ts), never in memory.
 *
 * Stored format: `scrypt-p1$<N>$<r>$<p>$<salt b64url>$<key b64url>`, so the cost can be raised
 * later without invalidating existing PINs (verify reads the parameters from the hash).
 *
 * A 4-digit PIN has only 10 000 values: scrypt alone can't keep a copied hash from being tried
 * in minutes, and `pnpm data:export` writes every PIN hash to a file people keep off the PC. So
 * the PIN is peppered: scrypt hashes HMAC-SHA256(pepper, pin), the pepper derived from
 * SESSION_SECRET (HKDF, its own label), which lives in .env.local, never in the database or an
 * export. A copied hash is useless without that secret; on the farm what protects a PIN is the
 * lockout (PIN_RULES: 5 tries, then 15 minutes). A restore on another PC with another
 * SESSION_SECRET needs the PINs set again (the owner's: `pnpm auth:reset-owner`).
 *
 * Hashes written before the pepper (`scrypt$…`) still verify, and a successful sign-in rewrites
 * them peppered (./store.ts attemptPin, `needsRehash`). Setting a PIN also refuses the guessable
 * ones (1111, 1234, 1212, ...).
 */
import {
  createHmac,
  hkdfSync,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { getConfig } from '../../config';
import { PIN_RULES } from './types';

const KEY_LEN = 32;
const PEPPERED = 'scrypt-p1';
const LEGACY = 'scrypt';

const peppers = new Map<string, Uint8Array>();

/** The PIN pepper for `secret` (HKDF-SHA256, label 'pin pepper v1'). */
export function pinPepper(secret: string): Uint8Array {
  let p = peppers.get(secret);
  if (!p) {
    p = new Uint8Array(hkdfSync('sha256', secret, 'farm-ops', 'pin pepper v1', 32));
    peppers.set(secret, p);
  }
  return p;
}

/** This install's pepper (SESSION_SECRET). Callers outside tests pass nothing. */
function configPepper(): Uint8Array {
  return pinPepper(getConfig().SESSION_SECRET);
}

/** What scrypt hashes: the PIN keyed with the pepper (or the bare PIN for a legacy hash). */
function scryptInput(pin: string, pepper: Uint8Array | null): string | Buffer {
  return pepper ? createHmac('sha256', pepper).update(pin).digest() : pin;
}

/** A stored hash from before the pepper: rewrite it at the next good sign-in. */
export function needsRehash(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(`${LEGACY}$`);
}
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

function scryptAsync(pin: string | Buffer, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmem = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024;

/**
 * Hash a PIN for farm.app_users.pin_hash (call pinProblem first). `pepper`: tests only; the
 * app uses this install's (SESSION_SECRET).
 */
export async function hashPin(pin: string, pepper: Uint8Array = configPepper()): Promise<string> {
  if (!isWellFormedPin(pin)) throw new Error('not a PIN');
  const { N, r, p } = DEFAULT_COST;
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(scryptInput(pin, pepper), salt, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return [PEPPERED, N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  peppered: boolean;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || (parts[0] !== PEPPERED && parts[0] !== LEGACY)) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4] as string, 'base64url');
  const key = Buffer.from(parts[5] as string, 'base64url');
  const pow2 = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!pow2 || N > MAX_N || !Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4 || salt.length < 8 || key.length !== KEY_LEN) {
    return null;
  }
  return { peppered: parts[0] === PEPPERED, N, r, p, salt, key };
}

/**
 * Does `pin` match `stored` (peppered, or a legacy hash)? Constant-time compare; false for a
 * malformed hash or PIN. `pepper`: tests only.
 */
export async function verifyPin(
  pin: unknown,
  stored: string | null | undefined,
  pepper?: Uint8Array,
): Promise<boolean> {
  const h = stored ? parseHash(stored) : null;
  if (!h || !isWellFormedPin(pin)) {
    await burn();
    return false;
  }
  const input = scryptInput(pin, h.peppered ? (pepper ?? configPepper()) : null);
  const got = await scryptAsync(input, h.salt, {
    N: h.N,
    r: h.r,
    p: h.p,
    maxmem: maxmem(h.N, h.r),
  });
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
