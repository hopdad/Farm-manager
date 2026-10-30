/**
 * Zipped vector files under limits, shared by the boundary importer (tools/import/boundary-file.ts,
 * also behind the /admin/fields upload) and the 1d importers (tools/gis/parcels-io.ts:
 * `gis:parcels`, `import:tile`). Pure: bytes in, entries out.
 *
 * Why not hand the zip to shpjs: shpjs 6.2.0 (lib/unzip.js) inflates every .shp/.dbf/.prj/.cpg/.json
 * entry fully into memory, in parallel, with no output limit, so one crafted 4 MB upload (a zip
 * bomb: one deflated entry of zeros, or many central-directory entries pointing at the same data)
 * expands to gigabytes and takes the single Next process down with it. Here every entry is
 * inflated with node:zlib `inflateRawSync({ maxOutputLength })` against what is left of
 * `maxUnzippedBytes` (stored entries count too), and the number of entries is capped.
 *
 * It also fixes how attributes are decoded: shpjs reads a .dbf with no .cpg as UTF-8, but a .dbf
 * without a .cpg is in the Windows ANSI code page (Windows-1252), so every é turned into U+FFFD
 * with no error. `guessDbfEncoding` picks UTF-8 only when the records ARE valid UTF-8, else
 * windows-1252; parsedbf hands that label to TextDecoder (Node has full ICU). It decodes in
 * streaming mode, which Node 24.13 gets right for 0x80-0x9F (its one-shot decode doesn't: see
 * `decodeCsvBytes` in ./csv.ts).
 *
 * Entries are grouped by their path without extension, case-insensitively (an export can carry
 * `Field.SHP` next to `Field.dbf`); `__MACOSX` resource forks are skipped; paths inside a
 * `<name>.gdb/` folder are reported as an Esri File Geodatabase (`gdbPaths`), which only GDAL reads.
 */
import { inflateRawSync } from 'node:zlib';
import { iter } from 'but-unzip';
import shp, { type ShpFeatureCollection } from 'shpjs';

export interface ZipLimits {
  /** Total bytes all kept entries may unpack to. */
  maxUnzippedBytes: number;
  /** Entries in the zip (all of them, kept or not). */
  maxEntries: number;
}

/** Admin uploads (4 MB zips) and the boundary CLI by default. */
export const UPLOAD_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxUnzippedBytes: 64 * 1024 * 1024,
  maxEntries: 2_000,
});

/** County and vendor files read on the PC (`gis:parcels`, `import:tile`). */
export const COUNTY_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxUnzippedBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
});

export class ZipReadError extends Error {
  override name = 'ZipReadError';
  constructor(
    message: string,
    readonly reason: 'too_big' | 'too_many' | 'unreadable',
  ) {
    super(message);
  }
}

export interface ZippedShapefile {
  /** Path inside the zip without extension, as spelled on the .shp entry. */
  path: string;
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: Uint8Array;
  cpg?: Uint8Array;
}

export interface ZippedVectors {
  shapefiles: ZippedShapefile[];
  /** .geojson / .json entries. */
  geojson: { path: string; bytes: Uint8Array }[];
  /** `<name>.gdb` folders (Esri File Geodatabase) found inside. */
  gdbPaths: string[];
  /** Bytes unpacked. */
  unzippedBytes: number;
}

const PART = /^(.*)\.(shp|dbf|prj|cpg)$/i;
const JSON_ENTRY = /\.(geo)?json$/i;
const GDB = /^(.*?\.gdb)\//i;

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** The vector entries of a zip, unpacked under `limits`. Throws ZipReadError. */
export async function unzipVectors(bytes: Uint8Array, limits: ZipLimits): Promise<ZippedVectors> {
  let total = 0;
  let entries = 0;
  const tooBig = () =>
    new ZipReadError(`the zip unpacks to more than ${mb(limits.maxUnzippedBytes)}`, 'too_big');
  const inflate = (raw: Uint8Array): Uint8Array => {
    const left = limits.maxUnzippedBytes - total;
    if (left <= 0) throw tooBig();
    try {
      return inflateRawSync(raw, { maxOutputLength: left });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
      throw new ZipReadError(
        `a file in the zip is damaged (${(e as Error).message})`,
        'unreadable',
      );
    }
  };
  const groups = new Map<string, Partial<ZippedShapefile>>();
  const geojson: ZippedVectors['geojson'] = [];
  const gdb = new Set<string>();
  try {
    for (const entry of iter(bytes, inflate)) {
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new ZipReadError(`the zip holds more than ${limits.maxEntries} files`, 'too_many');
      }
      const name = entry.filename.replace(/\\/g, '/');
      if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name)) continue;
      const g = GDB.exec(name);
      if (g) {
        gdb.add(g[1] as string);
        continue;
      }
      const part = PART.exec(name);
      if (!part && !JSON_ENTRY.test(name)) continue;
      const data = await entry.read();
      total += data.length;
      if (total > limits.maxUnzippedBytes) throw tooBig();
      if (!part) {
        geojson.push({ path: name, bytes: data });
        continue;
      }
      const base = part[1] as string;
      const kind = (part[2] as string).toLowerCase() as 'shp' | 'dbf' | 'prj' | 'cpg';
      const key = base.toLowerCase();
      const group = groups.get(key) ?? {};
      group[kind] = data;
      if (kind === 'shp') group.path = base;
      groups.set(key, group);
    }
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    // but-unzip: "but-unzip~2" (no end of central directory: not a zip), "~1" (a compression
    // method other than stored or deflate), "~3" (a multi-disk zip).
    throw new ZipReadError(`not a readable zip (${(e as Error).message})`, 'unreadable');
  }
  const shapefiles: ZippedShapefile[] = [];
  for (const g of groups.values()) {
    if (g.shp && g.path !== undefined) shapefiles.push(g as ZippedShapefile);
  }
  shapefiles.sort((a, b) => a.path.localeCompare(b.path));
  return { shapefiles, geojson, gdbPaths: [...gdb].sort(), unzippedBytes: total };
}

/**
 * The text encoding of a .dbf that came without a .cpg: 'utf-8' when its records are valid
 * UTF-8 (pure ASCII included), else 'windows-1252' (what ArcGIS and Excel-era tools write on
 * Windows). Field descriptors hold binary lengths, so only the records are checked.
 */
export function guessDbfEncoding(dbf: Uint8Array): string {
  if (dbf.length < 32) return 'utf-8';
  const headerLen = (dbf[8] as number) | ((dbf[9] as number) << 8);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(dbf.subarray(Math.min(headerLen, dbf.length)));
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** The encoding label to decode a .dbf with: its .cpg's, else a guess from the bytes. */
export function dbfEncoding(
  dbf: Uint8Array | undefined,
  cpg: Uint8Array | undefined,
): string | undefined {
  const named = cpg ? new TextDecoder().decode(cpg).trim() : '';
  if (named) return named;
  return dbf ? guessDbfEncoding(dbf) : undefined;
}

/** One shapefile's features (reprojected to WGS84 with its .prj by shpjs). */
export async function parseShapefileParts(parts: {
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: Uint8Array;
  cpg?: Uint8Array;
}): Promise<ShpFeatureCollection> {
  const fc = await shp({
    shp: parts.shp,
    dbf: parts.dbf,
    prj: parts.prj ? new TextDecoder().decode(parts.prj) : undefined,
    cpg: dbfEncoding(parts.dbf, parts.cpg),
  });
  if (Array.isArray(fc)) throw new Error('unexpected several layers');
  return fc;
}
