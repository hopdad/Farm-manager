/**
 * File helpers for the GIS tools: streaming sha256, atomic writes (temp file + rename in the
 * same directory) and content-addressed installs into the storage tree. node:fs only, so they
 * behave the same on Windows (rename over an existing file is atomic on NTFS too).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { contentAddressedName } from '../../src/platform/storage/keys';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Write `data` to `file` atomically (a reader sees the old or the new file, never half). */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export interface InstalledObject {
  /** Key inside the bucket, e.g. basemap.1a2b3c4d.pmtiles. */
  key: string;
  sha256: string;
  bytes: number;
  /** False when an identical object was already there (the temp file is then removed). */
  created: boolean;
}

/**
 * Move `tmpFile` into `bucketDir` as `<stem>.<sha8>.<ext>`. Content-addressed objects are never
 * overwritten: if the name exists with the same size, the existing file is kept.
 */
export async function installContentAddressed(
  tmpFile: string,
  bucketDir: string,
  stem: string,
  ext: string,
): Promise<InstalledObject> {
  const sha256 = await sha256File(tmpFile);
  const { size } = await stat(tmpFile);
  const key = contentAddressedName(stem, sha256, ext);
  const dest = path.join(bucketDir, key);
  await mkdir(bucketDir, { recursive: true });
  const existing = await stat(dest).catch(() => null);
  if (existing) {
    if (existing.size !== size) {
      throw new Error(
        `${dest} exists with another size; refusing to overwrite a content-addressed object`,
      );
    }
    await rm(tmpFile, { force: true });
    return { key, sha256, bytes: size, created: false };
  }
  await rename(tmpFile, dest);
  return { key, sha256, bytes: size, created: true };
}

/** Delete `<stem>.<sha8>.<ext>` files in `dir` other than `keep`. Returns the removed names. */
export async function removeOtherVersions(
  dir: string,
  stem: string,
  ext: string,
  keep: string,
): Promise<string[]> {
  const re = new RegExp(`^${stem}\\.[0-9a-f]{8}\\.${ext}$`);
  const removed: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name !== keep && re.test(name)) {
      await rm(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}
