/**
 * Signed storage URLs for the local adapter (docs/contracts-m1.md §9): the query string of
 * `/api/storage/<bucket>/<key>?…` carries an expiry, for uploads the byte limit and the content
 * type, and an HMAC-SHA256 over all of them plus the method, bucket and key. Nothing else in the
 * URL is trusted. Pure (node:crypto only), so the route, the writer and the tests share it.
 *
 * Production (MD) uses Supabase Storage's own signed URLs (createSignedUploadUrl /
 * createSignedUrl); this file is the local stand-in for those.
 *
 * Key: the MAC key is derived from SESSION_SECRET with a purpose label (HMAC(secret, label)), so
 * a storage signature can never be replayed as a session cookie signature or the other way round.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StorageBucket } from './keys';

/** Bumped if the canonical string ever changes (old URLs then fail closed). */
export const STORAGE_SIGNATURE_VERSION = 'v1';
const KEY_LABEL = 'farm-ops storage url signing v1';

/** Query parameter names. `sig` present = the caller claims a signed URL. */
export const SIGNED_PARAMS = {
  expires: 'exp',
  maxBytes: 'max',
  contentType: 'ct',
  signature: 'sig',
} as const;

export interface SignedPutClaims {
  method: 'PUT';
  bucket: StorageBucket;
  /** Normalized key (parseStorageKey). */
  key: string;
  /** Unix seconds; the URL is valid strictly before this instant. */
  expires: number;
  /** Largest body the PUT may send. */
  maxBytes: number;
  /** The Content-Type the PUT must carry (lower-case, as normalized by normalizeContentType). */
  contentType: string;
}

export interface SignedGetClaims {
  method: 'GET';
  bucket: StorageBucket;
  key: string;
  expires: number;
}

export type SignedClaims = SignedPutClaims | SignedGetClaims;

export type SignatureFailure = 'missing' | 'malformed' | 'bad-signature' | 'expired';

export type VerifyResult<C extends SignedClaims> =
  | { ok: true; claims: C }
  | { ok: false; reason: SignatureFailure };

/** `Text/CSV ;  Charset=UTF-8` → `text/csv; charset=utf-8` (case and spacing never matter). */
export function normalizeContentType(value: string): string {
  return value
    .split(';')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
    .join('; ');
}

function macKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error('storage signing secret must be at least 32 characters');
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

/** The exact bytes the MAC covers: one field per line, in a fixed order. */
export function canonicalString(c: SignedClaims): string {
  const lines = [STORAGE_SIGNATURE_VERSION, c.method, c.bucket, c.key, String(c.expires)];
  if (c.method === 'PUT') lines.push(String(c.maxBytes), c.contentType);
  return lines.join('\n');
}

function mac(secret: string, c: SignedClaims): string {
  return createHmac('sha256', macKey(secret)).update(canonicalString(c)).digest('base64url');
}

/** The query parameters of a signed URL for these claims (append them to the object URL). */
export function signStorageClaims(secret: string, c: SignedClaims): URLSearchParams {
  if (!Number.isSafeInteger(c.expires) || c.expires <= 0) throw new Error('bad expiry');
  const q = new URLSearchParams();
  q.set(SIGNED_PARAMS.expires, String(c.expires));
  if (c.method === 'PUT') {
    if (!Number.isSafeInteger(c.maxBytes) || c.maxBytes < 0) throw new Error('bad maxBytes');
    q.set(SIGNED_PARAMS.maxBytes, String(c.maxBytes));
    q.set(SIGNED_PARAMS.contentType, c.contentType);
  }
  q.set(SIGNED_PARAMS.signature, mac(secret, c));
  return q;
}

const INT_RE = /^[1-9]\d{0,15}$|^0$/;

function intParam(q: URLSearchParams, name: string): number | null {
  const v = q.get(name);
  if (v === null || !INT_RE.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Check a signed URL's query against the request's method, bucket and (normalized) key.
 * `missing`: no signature at all (the route then answers as for an unsigned request).
 */
export function verifySignedPut(
  secret: string,
  bucket: StorageBucket,
  key: string,
  q: URLSearchParams,
  now: Date,
): VerifyResult<SignedPutClaims> {
  const sig = q.get(SIGNED_PARAMS.signature);
  if (sig === null) return { ok: false, reason: 'missing' };
  const expires = intParam(q, SIGNED_PARAMS.expires);
  const maxBytes = intParam(q, SIGNED_PARAMS.maxBytes);
  const ct = q.get(SIGNED_PARAMS.contentType);
  if (expires === null || maxBytes === null || ct === null || ct.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const claims: SignedPutClaims = {
    method: 'PUT',
    bucket,
    key,
    expires,
    maxBytes,
    contentType: ct,
  };
  if (!sameMac(sig, mac(secret, claims))) return { ok: false, reason: 'bad-signature' };
  if (now.getTime() >= expires * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

export function verifySignedGet(
  secret: string,
  bucket: StorageBucket,
  key: string,
  q: URLSearchParams,
  now: Date,
): VerifyResult<SignedGetClaims> {
  const sig = q.get(SIGNED_PARAMS.signature);
  if (sig === null) return { ok: false, reason: 'missing' };
  const expires = intParam(q, SIGNED_PARAMS.expires);
  if (expires === null) return { ok: false, reason: 'malformed' };
  const claims: SignedGetClaims = { method: 'GET', bucket, key, expires };
  if (!sameMac(sig, mac(secret, claims))) return { ok: false, reason: 'bad-signature' };
  if (now.getTime() >= expires * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** Unix seconds `seconds` after `now` (rounded up, so a grant never lasts less than asked). */
export function expiryAfter(now: Date, seconds: number): number {
  return Math.ceil(now.getTime() / 1000) + seconds;
}
