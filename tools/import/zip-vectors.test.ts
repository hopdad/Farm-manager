/**
 * Zips under limits (a zip bomb can't take the server down) and .dbf text decoding (a .dbf
 * without a .cpg is Windows-1252 unless it is valid UTF-8), through the boundary importer too.
 */
import { describe, expect, test, vi } from 'vitest';
import { BoundaryFileError, parseBoundaryFiles, readBoundaryFiles } from './boundary-file';
import { rectangle, shapefileFiles, zip } from './testing/shapefile';
import { guessDbfEncoding, unzipVectors, ZipReadError } from './zip-vectors';

const MB = 1024 * 1024;
const small = { maxUnzippedBytes: MB, maxEntries: 50 };

async function zipError(p: Promise<unknown>): Promise<ZipReadError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ZipReadError) return e;
    throw e;
  }
  throw new Error('expected a ZipReadError');
}

/** One field named `name` (bytes as given, so tests can write Windows-1252). */
function fieldFiles(base: string, nameBytes: number[]): Record<string, Uint8Array> {
  const placeholder = 'X'.repeat(nameBytes.length);
  const files = shapefileFiles(base, [
    { geometry: rectangle(-83.9, 41.9, 300, 300), attributes: { FIELD_NAME: placeholder } },
  ]);
  const dbf = files[`${base}.dbf`] as Uint8Array;
  const at = Buffer.from(dbf).indexOf(placeholder);
  dbf.set(nameBytes, at);
  return files;
}

const PEREZ_1252 = [0x50, 0xc9, 0x52, 0x45, 0x5a]; // "PÉREZ" in Windows-1252

describe('unzipVectors limits', () => {
  test('an entry that unpacks past the limit is refused before it is all in memory', async () => {
    const bomb = zip({ 'a.shp': new Uint8Array(16 * MB) }); // deflates to ~16 KB
    expect(bomb.length).toBeLessThan(100_000);
    const e = await zipError(unzipVectors(bomb, small));
    expect(e.reason).toBe('too_big');
    expect(e.message).toMatch(/more than 1 MB/);
  });

  test('many entries that each fit still count against the total', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.dbf`] = new Uint8Array(300 * 1024);
    expect((await zipError(unzipVectors(zip(files), small))).reason).toBe('too_big');
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 60; i++) many[`readme${i}.txt`] = new Uint8Array(1);
    expect((await zipError(unzipVectors(zip(many), small))).reason).toBe('too_many');
  });

  test('not a zip', async () => {
    const e = await zipError(unzipVectors(new TextEncoder().encode('hello'), small));
    expect(e.reason).toBe('unreadable');
  });

  test('sidecars pair up whatever their case; __MACOSX and geodatabases are told apart', async () => {
    const files = shapefileFiles('Export/Field', [
      { geometry: rectangle(-83.9, 41.9, 300, 300), attributes: { FIELD_NAME: 'North' } },
    ]);
    const z = await unzipVectors(
      zip({
        'Export/Field.SHP': files['Export/Field.shp'] as Uint8Array,
        'Export/field.dbf': files['Export/Field.dbf'] as Uint8Array,
        '__MACOSX/Export/._Field.shp': new Uint8Array(10),
        'County.gdb/a00000001.gdbtable': new Uint8Array(10),
        'notes.geojson': new TextEncoder().encode('{"type":"FeatureCollection","features":[]}'),
      }),
      small,
    );
    expect(z.shapefiles.map((s) => [s.path, !!s.dbf])).toEqual([['Export/Field', true]]);
    expect(z.gdbPaths).toEqual(['County.gdb']);
    expect(z.geojson.map((g) => g.path)).toEqual(['notes.geojson']);
  });

  test('the boundary upload refuses a zip bomb with a readable message', async () => {
    const bomb = zip({ 'a.shp': new Uint8Array(16 * MB) });
    await expect(readBoundaryFiles([{ name: 'b.zip', bytes: bomb }], small)).rejects.toThrow(
      BoundaryFileError,
    );
    await expect(readBoundaryFiles([{ name: 'b.zip', bytes: bomb }], small)).rejects.toThrow(
      /b\.zip: the zip unpacks to more than 1 MB; split it, or import it on the PC/,
    );
  });
});

describe('.dbf text encoding', () => {
  test('guessDbfEncoding: valid UTF-8 (or ASCII) is UTF-8, anything else Windows-1252', () => {
    const ascii = fieldFiles('a', [...Buffer.from('PEREZ')])['a.dbf'] as Uint8Array;
    expect(guessDbfEncoding(ascii)).toBe('utf-8');
    const utf8 = fieldFiles('a', [...Buffer.from('PÉREZ', 'utf8')])['a.dbf'] as Uint8Array;
    expect(guessDbfEncoding(utf8)).toBe('utf-8');
    const ansi = fieldFiles('a', PEREZ_1252)['a.dbf'] as Uint8Array;
    expect(guessDbfEncoding(ansi)).toBe('windows-1252');
  });

  test('a Windows-1252 .dbf without a .cpg keeps its accents, zipped or not', async () => {
    const files = fieldFiles('Fields', PEREZ_1252);
    const zipped = await parseBoundaryFiles([{ name: 'export.zip', bytes: zip(files) }]);
    expect(zipped.errors).toEqual([]);
    expect(zipped.boundaries[0]?.name).toBe('PÉREZ');
    const loose = await parseBoundaryFiles(
      Object.entries(files).map(([name, bytes]) => ({ name, bytes })),
    );
    expect(loose.boundaries[0]?.name).toBe('PÉREZ');
  });

  // Node 24.13 decodes 0x80-0x9F as ISO-8859-1 in one-shot TextDecoder calls (Derrick's PC; see
  // tools/import/csv.ts); its streaming decode, which parsedbf uses, is right. The test plays
  // 24.13's one-shot bug on any Node, so a switch to one-shot decoding fails here, on CI too.
  test('Windows-1252 punctuation (0x80-0x9F) survives, with or without a .cpg', async () => {
    const decode = TextDecoder.prototype.decode;
    const spy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
      this: TextDecoder,
      input,
      options,
    ) {
      if (this.encoding === 'windows-1252' && !options?.stream && input) {
        const view = ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
        return Buffer.from(view).toString('latin1');
      }
      return decode.call(this, input, options);
    });
    try {
      // The stand-in really misreads one-shot calls, as 24.13 does.
      expect(new TextDecoder('windows-1252').decode(Uint8Array.of(0x92))).toBe('\u0092');
      const obrien = [0x4f, 0x92, 0x42, 0x52, 0x49, 0x45, 0x4e]; // "O’BRIEN" in Windows-1252
      const bare = await parseBoundaryFiles([
        { name: 'export.zip', bytes: zip(fieldFiles('F', obrien)) },
      ]);
      expect(bare.boundaries[0]?.name).toBe('O’BRIEN');
      const named = {
        ...fieldFiles('F', obrien),
        'F.cpg': new TextEncoder().encode('ANSI 1252'),
      };
      const b = await parseBoundaryFiles([{ name: 'export.zip', bytes: zip(named) }]);
      expect(b.boundaries[0]?.name).toBe('O’BRIEN');
    } finally {
      spy.mockRestore();
    }
  });

  test('a UTF-8 .dbf, and a .cpg that names the code page, are read as they say', async () => {
    const utf8 = fieldFiles('Fields', [...Buffer.from('Pérez', 'utf8')]);
    const a = await parseBoundaryFiles([{ name: 'export.zip', bytes: zip(utf8) }]);
    expect(a.boundaries[0]?.name).toBe('Pérez');
    const named = {
      ...fieldFiles('Fields', PEREZ_1252),
      'Fields.cpg': new TextEncoder().encode('1252\r\n'),
    };
    const b = await parseBoundaryFiles([{ name: 'export.zip', bytes: zip(named) }]);
    expect(b.boundaries[0]?.name).toBe('PÉREZ');
  });
});
