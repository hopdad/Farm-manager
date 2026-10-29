/**
 * Storage keys and buckets (contracts §10). Pure: no filesystem, so the route, the adapter and
 * the tests share one definition of what a valid key is.
 *
 * A key is a `/`-separated relative path inside a bucket, e.g. `basemap.1a2b3c4d.pmtiles` or
 * `assets/fonts/Noto Sans Regular/0-255.pbf`. The guard rejects anything that could escape the
 * bucket on Windows or POSIX: empty segments, `.` / `..`, backslashes, NUL and other control
 * characters, drive letters (`C:`), leading slashes (absolute keys) and over-long keys. The adapter
 * additionally checks that the resolved path stays under `<root>/<bucket>/`.
 */

/** Buckets that exist. M0 serves only `tiles`; `uploads` (private) arrives in 2c. */
export const STORAGE_BUCKETS = ['tiles', 'uploads'] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/** Buckets the read route serves in M0 (others answer 404). */
export const PUBLIC_READ_BUCKETS: readonly StorageBucket[] = ['tiles'];

/** Longest key we accept (bytes of UTF-16 code units; well below every OS path limit). */
export const MAX_KEY_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 200;

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

export function isStorageBucket(value: string): value is StorageBucket {
  return (STORAGE_BUCKETS as readonly string[]).includes(value);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Characters Windows forbids in file names (besides `\` and control characters). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;
/** CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with or without an extension) can't be files on Windows. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate a key given as a string or as route segments (`[...key]` params, already
 * percent-decoded by Next). Returns the normalized key (segments joined with `/`).
 * Throws StorageKeyError with the reason.
 */
export function parseStorageKey(input: string | readonly string[]): string {
  const raw = typeof input === 'string' ? input : input.join('/');
  if (raw.length === 0) throw new StorageKeyError('empty key');
  if (raw.length > MAX_KEY_LENGTH) throw new StorageKeyError('key too long');
  if (CONTROL_CHARS.test(raw)) throw new StorageKeyError('control character in key');
  if (raw.includes('\\')) throw new StorageKeyError('backslash in key');
  if (raw.startsWith('/')) throw new StorageKeyError('absolute key');
  if (/^[a-zA-Z]:/.test(raw)) throw new StorageKeyError('drive letter in key');
  const segments = raw.split('/');
  for (const s of segments) {
    if (s.length === 0) throw new StorageKeyError('empty path segment');
    if (s === '.' || s === '..') throw new StorageKeyError(`'${s}' segment`);
    if (s.length > MAX_SEGMENT_LENGTH) throw new StorageKeyError('path segment too long');
    if (WINDOWS_RESERVED_CHARS.test(s)) throw new StorageKeyError('reserved character in key');
    if (WINDOWS_RESERVED_NAMES.test(s)) throw new StorageKeyError('reserved file name in key');
    if (s.endsWith('.') || s.endsWith(' ')) {
      // Windows silently strips these, so two different keys could name one file.
      throw new StorageKeyError('path segment ends with a dot or space');
    }
  }
  return segments.join('/');
}

/** Like parseStorageKey but returns null instead of throwing. */
export function tryParseStorageKey(input: string | readonly string[]): string | null {
  try {
    return parseStorageKey(input);
  } catch (e) {
    if (e instanceof StorageKeyError) return null;
    throw e;
  }
}

/** `name.<sha8>.ext` in the last segment: content-addressed, never overwritten. */
const CONTENT_ADDRESSED = /(?:^|\/)[^/]+\.([0-9a-f]{8})\.[a-z0-9]+$/;

/** The sha8 of a content-addressed key (`basemap.1a2b3c4d.pmtiles` → `1a2b3c4d`), else null. */
export function contentHashOf(key: string): string | null {
  return CONTENT_ADDRESSED.exec(key)?.[1] ?? null;
}

/** Name for a content-addressed object: `<stem>.<sha8>.<ext>` (sha8 = first 8 hex of sha256). */
export function contentAddressedName(stem: string, sha256Hex: string, ext: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error('expected a sha256 hex digest');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(stem)) throw new Error(`bad stem '${stem}'`);
  if (!/^[a-z0-9]+$/.test(ext)) throw new Error(`bad extension '${ext}'`);
  return `${stem}.${sha256Hex.slice(0, 8)}.${ext}`;
}
