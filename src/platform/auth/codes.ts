/**
 * One-time codes (pure; node:crypto only):
 *
 *  - ENROLLMENT codes (farm.devices.enroll_code_hash): 10 Crockford base-32 characters (50 bits),
 *    shown as `K7QD2-M9XPA`, short enough to type on a cab iPad, inside a link and a QR code
 *    too. Only an HMAC of the code (keyed by SESSION_SECRET) is stored, so a copied database
 *    alone can't be brute-forced into codes; it expires after ENROLL_CODE_TTL_MINUTES and works
 *    once.
 *  - The OWNER SETUP code: derived from SESSION_SECRET (like the M0 admin key), so `pnpm run
 *    bootstrap` and every `pnpm dev` print the same link. It only works while the farm has no
 *    owner yet (./store.ts `realOwnerExists`): it dies by itself once the owner is set up.
 *  - OWNER RESET codes (`pnpm auth:reset-owner`): random, stored hashed in app.settings
 *    'auth.owner_reset' with a short expiry, consumed on use.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Crockford base 32: no I, L, O or U (nothing to misread on a screen). */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROLL_CODE_LENGTH = 10;
export const ENROLL_CODE_TTL_MINUTES = 60;
export const OWNER_RESET_TTL_MINUTES = 30;

/** A new random enrollment code (unformatted, 10 characters). */
export function newEnrollCode(): string {
  // 32 divides 256, so `byte & 31` is unbiased.
  return [...randomBytes(ENROLL_CODE_LENGTH)].map((b) => CODE_ALPHABET[b & 31]).join('');
}

/** `K7QD2M9XPA` -> `K7QD2-M9XPA`. */
export function formatEnrollCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * What someone typed (any case, dashes or spaces, O for 0, I or L for 1) -> the canonical code,
 * or null when it can't be one.
 */
export function normalizeEnrollCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== ENROLL_CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** The stored form of a code: hex HMAC-SHA256 under SESSION_SECRET, with a purpose label. */
export function hashCode(secret: string, purpose: 'enroll' | 'owner-reset', code: string): string {
  return createHmac('sha256', secret).update(`farm-ops ${purpose} code\n${code}`).digest('hex');
}

/** The install's owner setup code (base64url, 43 characters). */
export function ownerSetupCode(secret: string): string {
  return createHmac('sha256', secret).update('farm-ops owner setup v1').digest('base64url');
}

/** Is `candidate` this install's owner setup code? Constant-time. */
export function isOwnerSetupCode(secret: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const want = Buffer.from(ownerSetupCode(secret));
  const got = Buffer.from(candidate);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A new random owner reset code (base64url, 32 characters). */
export function newOwnerResetCode(): string {
  return randomBytes(24).toString('base64url');
}

/** Only codes that could be ours reach the database (length and alphabet). */
export function looksLikeResetCode(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{32}$/.test(candidate);
}
