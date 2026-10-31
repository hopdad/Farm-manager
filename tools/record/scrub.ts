/**
 * The recording scrubber (1f decision 3, docs/contracts-1f.md §8 and §10; owner: sync-health):
 * turns real vendor responses into fixtures with no real farm data in them, keeping their shapes
 * (so the live zod schemas still pass and replay still works):
 *
 *  - ids hashed: values under id-like keys (`id`, `…Id`, `…Ids`, `guid`, `principalId`, `vin`,
 *    `serialNumber`, …) become stable hashes of the same type (a numeric string stays digits of
 *    the same length, a number stays a number); the same id becomes the same hash everywhere
 *    (bodies, link URIs, request paths and query values), so recorded paging and links still
 *    line up;
 *  - names to stable pseudonyms: `name`, `displayName`, `operatorName`, notes, … (the names of
 *    catalog entries such as `isgType`, `make`, `model`, `flagCategory` are kept: they are
 *    Deere's vocabulary, not the farm's, and the mappers read them);
 *  - coordinates moved into the demo area: every lat/lon pair (and GeoJSON `coordinates`) is
 *    translated by one offset, so shapes and distances are kept and the recording lands on the
 *    simulated farm;
 *  - secrets dropped: token, secret, password and authorization values become 'redacted' and
 *    cursors are hashed; request headers are never kept at all (only method, path and query).
 *
 * `survivors(text)` is the final check: no original id or name may appear anywhere in a
 * scrubbed file. Pure; the recorder (./record.ts) observes every body first, then scrubs.
 */
import { createHash } from 'node:crypto';

/** The demo farm's shop yard (src/sim/farm/build.ts): recordings are moved around it. */
export const DEMO_AREA_CENTER = { lng: -83.8155, lat: 41.8628 } as const;

const ID_KEYS = new Set([
  'id',
  'ids',
  'guid',
  'uuid',
  'principalid',
  'serialnumber',
  'vin',
  'erid',
  'externalid',
  'externalids',
  'pin',
]);
const NAME_KEYS = new Set([
  'name',
  'displayname',
  'firstname',
  'lastname',
  'givenname',
  'familyname',
  'operatorname',
  'username',
  'email',
  'phone',
  'address',
  'formattedlocation',
  'notes',
  'note',
  'description',
  'licenseplate',
]);
const CURSOR_KEYS = new Set([
  'endcursor',
  'startcursor',
  'cursor',
  'nextcursor',
  'after',
  'before',
]);
const SECRET_RE = /token|secret|password|apikey|api_key|authorization|cookie/i;
/** Parents whose `name` (and `id`) is the vendor's catalog, not farm data. */
const CATALOG_PARENTS = new Set([
  'isgtype',
  'type',
  'make',
  'model',
  'equipmenttype',
  'flagcategory',
  'category',
  'machinestate',
  'measurementtype',
  'unit',
]);
/** Query parameters kept verbatim (everything else is treated as an id and hashed). */
export const QUERY_KEEP = new Set([
  'categories',
  'capableOf',
  'cropSeason',
  'fieldOperationType',
  'pageOffset',
  'itemLimit',
  'recordFilter',
  'embed',
  'lastKnown',
  'types',
  'status',
  'startDate',
  'endDate',
  'startTime',
  'endTime',
  'shapeType',
]);
const LAT_KEYS = new Set(['lat', 'latitude']);
const LNG_KEYS = new Set(['lon', 'lng', 'long', 'longitude']);

const lower = (k: string | null) => (k ?? '').toLowerCase();

function isNameKey(key: string | null, parent: string | null): boolean {
  return NAME_KEYS.has(lower(key)) && !CATALOG_PARENTS.has(lower(parent));
}

export interface ScrubberOptions {
  /** Per-recording salt: hashes are stable within a run (and between runs with the same salt). */
  salt: string;
  center?: { lng: number; lat: number };
}

export interface Scrubber {
  /** First pass: note every id, name and coordinate of a body (and of a request URL). */
  observe(body: unknown): void;
  observeUrl(url: URL): void;
  /** Second pass: the scrubbed copy of a body. */
  scrub(body: unknown): unknown;
  /** A path with its id segments replaced. */
  scrubPath(path: string): string;
  /** Query parameters with id values replaced (QUERY_KEEP kept). */
  scrubQuery(params: URLSearchParams): Record<string, string>;
  /** The original ids and names seen (for the survivors check). */
  originals(): string[];
  /** Originals that still appear in `text` (must be [] for a scrubbed file). */
  survivors(text: string): string[];
  /** The translation applied to coordinates (degrees). */
  offset(): { dLng: number; dLat: number };
}

export function createScrubber(opts: ScrubberOptions): Scrubber {
  const center = opts.center ?? DEMO_AREA_CENTER;
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const cursors = new Map<string, string>();
  let sumLng = 0;
  let sumLat = 0;
  let points = 0;
  let shift: { dLng: number; dLat: number } | null = null;

  const hex = (kind: string, v: string) =>
    createHash('sha256').update(`${opts.salt}\u0000${kind}\u0000${v}`).digest('hex');

  /** A stable replacement of the same shape: digits stay digits (same length), else h<hex>. */
  function hashId(v: string): string {
    const hit = ids.get(v);
    if (hit) return hit;
    const h = hex('id', v);
    let out: string;
    if (/^\d+$/.test(v)) {
      // Digits of the same length (no leading zero), different from the original.
      let digits = BigInt(`0x${h}`).toString();
      for (let i = 1; digits.length < v.length; i++) {
        digits += BigInt(`0x${hex(`id${i}`, v)}`).toString();
      }
      out = digits.slice(0, v.length);
      if (v.length > 1 && out[0] === '0') out = `9${out.slice(1)}`;
      if (out === v) out = `${out[0] === '9' ? '1' : '9'}${out.slice(1)}`;
    } else {
      const len = Math.max(8, Math.min(24, v.length));
      out = `h${h.slice(0, len - 1)}`;
    }
    ids.set(v, out);
    return out;
  }

  function hashNumber(n: number): number {
    const s = String(n);
    if (!/^\d+$/.test(s)) return n;
    return Number(hashId(s));
  }

  function pseudonym(key: string, v: string): string {
    const hit = names.get(v);
    if (hit) return hit;
    const label = key === 'email' ? 'user' : key.replace(/[^a-z]/gi, '') || 'name';
    const out =
      lower(key) === 'email'
        ? `user-${hex('name', v).slice(0, 6)}@example.invalid`
        : `${label[0]?.toUpperCase() ?? 'N'}${label.slice(1)} ${hex('name', v).slice(0, 6)}`;
    names.set(v, out);
    return out;
  }

  function hashCursor(v: string): string {
    const hit = cursors.get(v);
    if (hit) return hit;
    const out = `c${hex('cursor', v).slice(0, 23)}`;
    cursors.set(v, out);
    return out;
  }

  const noteId = (v: unknown) => {
    if (typeof v === 'string' && v) hashId(v);
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) hashId(String(v));
  };

  function idKey(key: string | null): boolean {
    const k = key ?? '';
    return ID_KEYS.has(k.toLowerCase()) || /[a-z0-9](Id|ID|Ids|IDs)$/.test(k);
  }

  function observe(body: unknown, key: string | null = null, parent: string | null = null): void {
    if (Array.isArray(body)) {
      if (lower(key) === 'coordinates') walkCoords(body, (lng, lat) => addPoint(lng, lat));
      for (const x of body) observe(x, key, parent);
      return;
    }
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      const latKey = Object.keys(o).find((k) => LAT_KEYS.has(k.toLowerCase()));
      const lngKey = Object.keys(o).find((k) => LNG_KEYS.has(k.toLowerCase()));
      if (latKey && lngKey && typeof o[latKey] === 'number' && typeof o[lngKey] === 'number') {
        addPoint(o[lngKey] as number, o[latKey] as number);
      }
      for (const [k, v] of Object.entries(o)) observe(v, k, key);
      return;
    }
    if (typeof body === 'string') {
      if (idKey(key)) noteId(body);
      else if (isNameKey(key, parent) && body.trim().length > 0) pseudonym(key ?? 'name', body);
      else if (/^https?:\/\//.test(body)) {
        try {
          observeUrl(new URL(body));
        } catch {
          // not a URL after all
        }
      } else if (body.startsWith('{') && body.includes('coordinates')) {
        try {
          observe(JSON.parse(body), key, parent);
        } catch {
          // not JSON
        }
      }
      return;
    }
    if (typeof body === 'number' && idKey(key)) noteId(body);
  }

  function observeUrl(url: URL): void {
    for (const seg of url.pathname.split('/')) {
      const s = decodeURIComponent(seg);
      if (/\d/.test(s) && !/^v\d+$/i.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) hashId(s);
    }
    for (const [k, v] of url.searchParams) {
      if (QUERY_KEEP.has(k)) continue;
      if (CURSOR_KEYS.has(k.toLowerCase())) hashCursor(v);
      else for (const part of v.split(',')) if (part) hashId(part);
    }
  }

  function addPoint(lng: number, lat: number): void {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    sumLng += lng;
    sumLat += lat;
    points++;
  }

  function walkCoords(a: unknown[], fn: (lng: number, lat: number) => void): void {
    if (a.length >= 2 && typeof a[0] === 'number' && typeof a[1] === 'number') {
      fn(a[0], a[1]);
      return;
    }
    for (const x of a) if (Array.isArray(x)) walkCoords(x, fn);
  }

  function getShift(): { dLng: number; dLat: number } {
    if (shift) return shift;
    shift = points
      ? { dLng: center.lng - sumLng / points, dLat: center.lat - sumLat / points }
      : { dLng: 0, dLat: 0 };
    return shift;
  }

  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

  function shiftCoords(a: unknown[]): unknown[] {
    const s = getShift();
    if (a.length >= 2 && typeof a[0] === 'number' && typeof a[1] === 'number') {
      return [round6(a[0] + s.dLng), round6(a[1] + s.dLat), ...a.slice(2)];
    }
    return a.map((x) => (Array.isArray(x) ? shiftCoords(x) : x));
  }

  function scrubUrlString(v: string): string {
    try {
      const u = new URL(v);
      const out = new URL(u.toString());
      out.pathname = scrubPath(u.pathname);
      out.search = '';
      for (const [k, val] of Object.entries(scrubQuery(u.searchParams)))
        out.searchParams.set(k, val);
      return out.toString();
    } catch {
      return v;
    }
  }

  function scrub(body: unknown, key: string | null = null, parent: string | null = null): unknown {
    if (Array.isArray(body)) {
      if (lower(key) === 'coordinates') return shiftCoords(body);
      return body.map((x) => scrub(x, key, parent));
    }
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const s = getShift();
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number' && LAT_KEYS.has(k.toLowerCase())) out[k] = round6(v + s.dLat);
        else if (typeof v === 'number' && LNG_KEYS.has(k.toLowerCase()))
          out[k] = round6(v + s.dLng);
        else out[k] = scrub(v, k, key);
      }
      return out;
    }
    if (typeof body === 'string') {
      const k = lower(key);
      if (CURSOR_KEYS.has(k)) return body ? hashCursor(body) : body;
      if (SECRET_RE.test(key ?? '')) return body ? 'redacted' : body;
      if (idKey(key)) return body ? hashId(body) : body;
      if (isNameKey(key, parent) && body.trim()) return pseudonym(key ?? 'name', body);
      if (/^https?:\/\//.test(body)) return scrubUrlString(body);
      if (body.startsWith('{') && body.includes('coordinates')) {
        try {
          return JSON.stringify(scrub(JSON.parse(body), key, parent));
        } catch {
          // not JSON
        }
      }
      const known = ids.get(body);
      return known ?? body;
    }
    if (typeof body === 'number' && idKey(key) && Number.isInteger(body) && body >= 0) {
      return hashNumber(body);
    }
    return body;
  }

  function scrubPath(path: string): string {
    return path
      .split('/')
      .map((seg) => {
        const s = decodeURIComponent(seg);
        const known = ids.get(s);
        if (known) return encodeURIComponent(known);
        if (/\d/.test(s) && !/^v\d+$/i.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) {
          return encodeURIComponent(hashId(s));
        }
        return seg;
      })
      .join('/');
  }

  function scrubQuery(params: URLSearchParams): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of params) {
      if (QUERY_KEEP.has(k)) out[k] = v;
      else if (CURSOR_KEYS.has(k.toLowerCase())) out[k] = hashCursor(v);
      else
        out[k] = v
          .split(',')
          .map((p) => (p ? hashId(p) : p))
          .join(',');
    }
    return out;
  }

  function originals(): string[] {
    return [...ids.keys(), ...names.keys(), ...cursors.keys()].filter((v) => v.length >= 3);
  }

  function survivors(text: string): string[] {
    const replaced = new Set([...ids.values(), ...names.values(), ...cursors.values()]);
    return originals().filter((v) => {
      if (replaced.has(v)) return false;
      // Quoted as a JSON string, as a path segment, or as a query value.
      const q = JSON.stringify(v).slice(1, -1);
      return (
        text.includes(`"${q}"`) ||
        text.includes(`/${encodeURIComponent(v)}`) ||
        text.includes(`=${encodeURIComponent(v)}`) ||
        // A numeric id as a JSON number.
        (/^\d+$/.test(v) && new RegExp(`[:\\[,]\\s*${v}\\s*[,\\]}]`).test(text))
      );
    });
  }

  return {
    observe: (b) => observe(b),
    observeUrl,
    scrub: (b) => scrub(b),
    scrubPath,
    scrubQuery,
    originals,
    survivors,
    offset: getShift,
  };
}
