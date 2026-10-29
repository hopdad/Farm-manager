/**
 * AES-256-GCM for ingest.oauth_tokens.ciphertext (plan §5, key TOKEN_ENC_KEY = 64 hex).
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url, 12-byte IV, 16-byte tag). The row's
 * `source|org` is bound as additional authenticated data, so a ciphertext copied onto another
 * row fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

/** TOKEN_ENC_KEY (64 hex) → key bytes. Throws a fix-it message when it is missing. */
export function tokenKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new TokenCryptoError(
      'TOKEN_ENC_KEY (64 hex characters) is required to store OAuth tokens: `pnpm env:init` writes one into .env.local',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(key: Buffer, text: string, aad: string): string {
  const parts = text.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError('unrecognized token ciphertext format');
  }
  const [, iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenCryptoError('token ciphertext does not decrypt (wrong TOKEN_ENC_KEY or row)');
  }
}
