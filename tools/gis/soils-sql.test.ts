import { describe, expect, test } from 'vitest';
import {
  areaSymbol,
  componentsSql,
  inList,
  mapunitStatsSql,
  NCCPI_RULE,
  polygonPageSql,
  polygonsSql,
  sdaKey,
  surveyAreasSql,
  tsqlString,
} from './soils-sql';

describe('validation (nothing unvalidated reaches the SQL)', () => {
  test('area symbols', () => {
    expect(areaSymbol(' mi091 ')).toBe('MI091');
    for (const bad of ['MI91', 'MI0911', "MI091'; DROP", '', '91MI0']) {
      expect(() => areaSymbol(bad)).toThrow(/survey area symbol/);
    }
  });

  test('keys are digits only', () => {
    expect(sdaKey('168543')).toBe('168543');
    for (const bad of ['', '12a', '1 OR 1=1', '-1', '1.5', '1234567890123']) {
      expect(() => sdaKey(bad)).toThrow(/SDA key/);
    }
  });

  test('T-SQL strings double their quotes', () => {
    expect(tsqlString("O'Brien")).toBe("'O''Brien'");
  });

  test('IN lists quote each key and refuse an empty list', () => {
    expect(inList(['1', '22'])).toBe("('1','22')");
    expect(() => inList([])).toThrow(/empty/);
  });
});

describe('queries', () => {
  test('survey catalogue for both counties', () => {
    expect(surveyAreasSql(['MI091', 'mi115'])).toBe(
      [
        'SELECT sc.areasymbol, sc.areaname, sc.saverest',
        'FROM sacatalog AS sc',
        "WHERE sc.areasymbol IN ('MI091','MI115')",
        'ORDER BY sc.areasymbol',
      ].join('\n'),
    );
  });

  test('map unit stats count polygons and vertices per mukey of one area', () => {
    const q = mapunitStatsSql('MI091');
    expect(q).toContain("WHERE l.areasymbol = 'MI091'");
    expect(q).toContain('COUNT(p.mupolygonkey) AS polygons');
    expect(q).toContain('p.mupolygongeo.STNumPoints()');
    expect(q).toContain('LEFT JOIN mupolygon AS p ON p.mukey = mu.mukey');
    expect(q).toContain('GROUP BY mu.mukey, mu.musym, mu.muname, mu.farmlndcl');
  });

  test('components carry NCCPI v3 from cointerp at rule depth 0', () => {
    const q = componentsSql(['168', '169']);
    expect(NCCPI_RULE).toBe('NCCPI - National Commodity Crop Productivity Index (Ver 3.0)');
    expect(q).toContain(
      `ci.ruledepth = 0 AND ci.mrulename = 'NCCPI - National Commodity Crop Productivity Index (Ver 3.0)'`,
    );
    expect(q).toContain("WHERE c.mukey IN ('168','169')");
    expect(q).toContain('ORDER BY c.mukey, c.comppct_r DESC, c.cokey');
  });

  test('polygons as WGS84 WKT, in key order', () => {
    const q = polygonsSql(['168']);
    expect(q).toContain('p.mupolygongeo.STAsText() AS wkt');
    expect(q).toContain("WHERE p.mukey IN ('168')");
    expect(q).toContain('ORDER BY p.mupolygonkey');
  });

  test('keyset pages for a map unit too big for one reply', () => {
    expect(polygonPageSql('168', '0', 500)).toBe(
      [
        'SELECT TOP 500 p.mupolygonkey, p.mukey, p.mupolygongeo.STAsText() AS wkt',
        'FROM mupolygon AS p',
        "WHERE p.mukey = '168' AND p.mupolygonkey > 0",
        'ORDER BY p.mupolygonkey',
      ].join('\n'),
    );
    expect(() => polygonPageSql('168', '0', 0)).toThrow(/page size/);
    expect(() => polygonPageSql('168', 'x', 10)).toThrow(/SDA key/);
  });
});
