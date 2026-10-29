/**
 * The libraries M1 adds, used the way the importers will (docs/contracts-m1.md §2):
 *  - shpjs: shapefile (+ .dbf attributes, + .prj reprojection to WGS84 via proj4)
 *  - csv-parse: spreadsheet CSVs (BOM, quoted commas, header row)
 * Pure JS, so they behave the same on Windows.
 */
import { parse } from 'csv-parse/sync';
import shp, { parseDbf, parseShp } from 'shpjs';
import { describe, expect, test } from 'vitest';

/** A one-point .shp (shape type 1) in memory. */
function pointShp(x: number, y: number): Uint8Array {
  const buf = new DataView(new ArrayBuffer(100 + 8 + 20));
  buf.setInt32(0, 9994); // file code (big-endian)
  buf.setInt32(24, buf.byteLength / 2); // file length in 16-bit words (big-endian)
  buf.setInt32(28, 1000, true); // version
  buf.setInt32(32, 1, true); // shape type: point
  for (const [i, v] of [x, y, x, y].entries()) buf.setFloat64(36 + i * 8, v, true); // bbox
  buf.setInt32(100, 1); // record number
  buf.setInt32(104, 10); // content length (words)
  buf.setInt32(108, 1, true);
  buf.setFloat64(112, x, true);
  buf.setFloat64(120, y, true);
  return new Uint8Array(buf.buffer);
}

/** A one-record .dbf with a character field NAME. */
function nameDbf(name: string): Uint8Array {
  const len = 20;
  const headerLen = 32 + 32 + 1;
  const recordLen = 1 + len;
  const buf = new Uint8Array(headerLen + recordLen + 1);
  const view = new DataView(buf.buffer);
  buf[0] = 0x03;
  buf[1] = 126; // 2026
  buf[2] = 11;
  buf[3] = 30;
  view.setUint32(4, 1, true);
  view.setUint16(8, headerLen, true);
  view.setUint16(10, recordLen, true);
  buf.set(new TextEncoder().encode('NAME'), 32);
  buf[32 + 11] = 'C'.charCodeAt(0);
  buf[32 + 16] = len;
  buf[64] = 0x0d;
  buf[65] = 0x20;
  buf.set(new TextEncoder().encode(name.padEnd(len, ' ')), 66);
  buf[buf.length - 1] = 0x1a;
  return buf;
}

const UTM16N_PRJ =
  'PROJCS["NAD_1983_UTM_Zone_16N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-87.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

describe('shpjs', () => {
  test('reads geometry and attributes from component files', async () => {
    const fc = await shp({ shp: pointShp(-84.05, 41.9), dbf: nameDbf('Kowalski North') });
    if (Array.isArray(fc)) throw new Error('one layer expected');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [-84.05, 41.9] });
    expect(fc.features[0]?.properties).toEqual({ NAME: 'Kowalski North' });
    expect(parseDbf(nameDbf('X'))).toEqual([{ NAME: 'X' }]);
  });

  test('reprojects with the .prj (UTM 16N -> WGS84)', () => {
    const [g] = parseShp(pointShp(500_000, 4_637_000), UTM16N_PRJ);
    if (g?.type !== 'Point') throw new Error('point expected');
    const [lng, lat] = g.coordinates;
    expect(lng).toBeCloseTo(-87, 5); // the zone's central meridian
    expect(lat).toBeCloseTo(41.88, 1);
  });
});

describe('csv-parse', () => {
  test('header row, BOM, quoted commas and blank lines (an Excel CSV)', () => {
    const text =
      '﻿field,crop_year,crop,yield_bu_ac\r\n"Kowalski North, west",2025,corn,212.5\r\n\r\nHome 80,2024,soybeans,61\r\n';
    const rows = parse(text, { bom: true, columns: true, skip_empty_lines: true, trim: true });
    expect(rows).toEqual([
      { field: 'Kowalski North, west', crop_year: '2025', crop: 'corn', yield_bu_ac: '212.5' },
      { field: 'Home 80', crop_year: '2024', crop: 'soybeans', yield_bu_ac: '61' },
    ]);
  });
});
