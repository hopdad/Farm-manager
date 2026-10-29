/**
 * The T-SQL `pnpm gis:soils` sends to Soil Data Access (pure; unit-tested). Owner: soils.
 *
 * SSURGO tables and columns used (SSURGO Table/Column descriptions, Soil Data Mart; SDA's
 * "Advanced Queries" page, https://sdmdataaccess.sc.egov.usda.gov/documents/AdvancedQueries.html):
 *  - sacatalog: areasymbol, areaname, saverest (survey version date; soilDB's own example query
 *    is `SELECT areasymbol, saverest FROM sacatalog`)
 *  - legend (lkey, areasymbol) → mapunit (lkey, mukey, musym, muname, farmlndcl)
 *  - component (mukey, cokey, compname, comppct_r, majcompflag, compkind, drainagecl, hydgrp)
 *  - cointerp (cokey, mrulename, ruledepth, interphr): interpretation ratings. NCCPI is the rule
 *    'NCCPI - National Commodity Crop Productivity Index (Ver 3.0)' at ruledepth 0 (the rule
 *    itself, not its sub-rules); interphr is the 0-1 index. Rule name as listed in NRCS soilDB's
 *    get_SDA_interpretation() docs (https://github.com/ncss-tech/soilDB/blob/master/R/get_SDA_interpretation.R),
 *    the same join soilDB uses (`cointerp.cokey = c.cokey AND ruledepth = 0 AND mrulename …`).
 *  - mupolygon (mupolygonkey, mukey, mupolygongeo): map unit polygons, WGS84 geometry in
 *    `mupolygongeo` (Web Mercator in `mupolygonproj`), returned as WKT with `.STAsText()` (the
 *    way soilDB's fetchSDA_spatial does). SDA's own SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84
 *    function returns `mupolygonkey`s, the per-polygon key we store as gis.soil_polygons.source_id.
 *
 * Only ever interpolates validated area symbols (`MI091`), mukeys and polygon keys (digits) and
 * the fixed rule name, so nothing a file or the network supplies reaches the SQL text.
 */

/** NCCPI v3 in SDA cointerp.mrulename (plan §6 1c open question, answered above). */
export const NCCPI_RULE = 'NCCPI - National Commodity Crop Productivity Index (Ver 3.0)';

const AREA_RE = /^[A-Z]{2}\d{3}$/;
const KEY_RE = /^\d{1,12}$/;

/** A survey area symbol such as 'MI091' (upper case), or throws. */
export function areaSymbol(raw: string): string {
  const a = raw.trim().toUpperCase();
  if (!AREA_RE.test(a)) throw new Error(`'${raw}' is not a soil survey area symbol (e.g. MI091)`);
  return a;
}

/** A mukey / mupolygonkey (digits), or throws. */
export function sdaKey(raw: string): string {
  if (!KEY_RE.test(raw)) throw new Error(`'${raw}' is not an SDA key (digits)`);
  return raw;
}

/** T-SQL string literal. */
export function tsqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** `('a','b')` for an IN list of validated keys (soilDB's format_SQL_in_statement). */
export function inList(keys: readonly string[]): string {
  if (keys.length === 0) throw new Error('empty IN list');
  return `(${keys.map((k) => tsqlString(sdaKey(k))).join(',')})`;
}

/** Survey catalogue rows (areasymbol, areaname, saverest) for the areas. */
export function surveyAreasSql(areas: readonly string[]): string {
  const list = areas.map((a) => tsqlString(areaSymbol(a))).join(',');
  return [
    'SELECT sc.areasymbol, sc.areaname, sc.saverest',
    'FROM sacatalog AS sc',
    `WHERE sc.areasymbol IN (${list})`,
    'ORDER BY sc.areasymbol',
  ].join('\n');
}

/**
 * One row per map unit of the area with its polygon count and total vertex count (the size
 * estimate that plans the polygon batches): mukey, musym, muname, farmlndcl, polygons, vertices.
 */
export function mapunitStatsSql(area: string): string {
  return [
    'SELECT mu.mukey, mu.musym, mu.muname, mu.farmlndcl,',
    '  COUNT(p.mupolygonkey) AS polygons,',
    '  SUM(CAST(p.mupolygongeo.STNumPoints() AS BIGINT)) AS vertices',
    'FROM legend AS l',
    'INNER JOIN mapunit AS mu ON mu.lkey = l.lkey',
    'LEFT JOIN mupolygon AS p ON p.mukey = mu.mukey',
    `WHERE l.areasymbol = ${tsqlString(areaSymbol(area))}`,
    'GROUP BY mu.mukey, mu.musym, mu.muname, mu.farmlndcl',
    'ORDER BY mu.mukey',
  ].join('\n');
}

/**
 * Components of the map units with each component's NCCPI (null when the rule has no rating for
 * it, e.g. water): mukey, cokey, compname, comppct_r, majcompflag, compkind, drainagecl, hydgrp,
 * nccpi.
 */
export function componentsSql(mukeys: readonly string[]): string {
  return [
    'SELECT c.mukey, c.cokey, c.compname, c.comppct_r, c.majcompflag, c.compkind,',
    '  c.drainagecl, c.hydgrp,',
    '  (SELECT MAX(ci.interphr) FROM cointerp AS ci',
    `    WHERE ci.cokey = c.cokey AND ci.ruledepth = 0 AND ci.mrulename = ${tsqlString(NCCPI_RULE)}) AS nccpi`,
    'FROM component AS c',
    `WHERE c.mukey IN ${inList(mukeys)}`,
    'ORDER BY c.mukey, c.comppct_r DESC, c.cokey',
  ].join('\n');
}

/** Every polygon of the map units, as WKT: mupolygonkey, mukey, wkt. */
export function polygonsSql(mukeys: readonly string[]): string {
  return [
    'SELECT p.mupolygonkey, p.mukey, p.mupolygongeo.STAsText() AS wkt',
    'FROM mupolygon AS p',
    `WHERE p.mukey IN ${inList(mukeys)}`,
    'ORDER BY p.mupolygonkey',
  ].join('\n');
}

/**
 * One page of one map unit's polygons (keyset paging on mupolygonkey) for a map unit too big for
 * a single reply: the next `top` polygons after `afterKey` (0 for the first page).
 */
export function polygonPageSql(mukey: string, afterKey: string, top: number): string {
  if (!Number.isInteger(top) || top < 1 || top > 100_000) throw new Error(`bad page size ${top}`);
  return [
    `SELECT TOP ${top} p.mupolygonkey, p.mukey, p.mupolygongeo.STAsText() AS wkt`,
    'FROM mupolygon AS p',
    `WHERE p.mukey = ${tsqlString(sdaKey(mukey))} AND p.mupolygonkey > ${sdaKey(afterKey)}`,
    'ORDER BY p.mupolygonkey',
  ].join('\n');
}
