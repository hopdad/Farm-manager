/**
 * The Drizzle schema matches the migrated database, geometry columns are indexed, the custom
 * column types round-trip, and farm_app has exactly the privileges the app needs.
 */
import { eq, getTableName, is } from 'drizzle-orm';
import { getTableConfig, getViewConfig, PgTable, PgView } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '../test/fixtures';
import { asGeoJson } from './geo';
import * as schema from './schema';

const t = setupTestDb(import.meta.url);

async function dbColumns(schemaName: string, table: string) {
  const r = await t().admin.query(
    `select column_name, is_nullable from information_schema.columns
      where table_schema = $1 and table_name = $2`,
    [schemaName, table],
  );
  return new Map(r.rows.map((row) => [row.column_name as string, row.is_nullable === 'YES']));
}

describe('schema', () => {
  test('every Drizzle table and view matches the database columns', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const value of Object.values(schema)) {
      let schemaName: string | undefined;
      let name: string;
      let columns: { name: string; notNull: boolean }[];
      if (is(value, PgTable)) {
        const c = getTableConfig(value);
        schemaName = c.schema;
        name = c.name;
        columns = c.columns;
      } else if (is(value, PgView)) {
        const c = getViewConfig(value);
        schemaName = c.schema;
        name = c.name;
        columns = Object.values(
          c.selectedFields as Record<string, { name: string; notNull: boolean }>,
        );
      } else continue;
      checked++;
      const actual = await dbColumns(schemaName ?? 'public', name);
      if (!actual.size) problems.push(`${schemaName}.${name}: missing in database`);
      for (const col of columns) {
        if (!actual.has(col.name)) problems.push(`${schemaName}.${name}.${col.name}: missing`);
        else if (is(value, PgTable) && actual.get(col.name) === col.notNull)
          problems.push(`${schemaName}.${name}.${col.name}: nullability differs`);
      }
      const known = new Set(columns.map((c) => c.name));
      for (const dbCol of actual.keys()) {
        if (!known.has(dbCol))
          problems.push(`${schemaName}.${name}.${dbCol}: not in Drizzle schema`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(17);
  });

  test('every geometry column has a GiST index', async () => {
    const r = await t().admin.query(`
      select c.table_schema || '.' || c.table_name || '.' || c.column_name as col
        from information_schema.columns c
       where c.table_schema in ('farm', 'gis', 'ingest', 'app') and c.udt_name = 'geometry'
         and exists (select 1 from information_schema.tables tb
                      where tb.table_schema = c.table_schema and tb.table_name = c.table_name
                        and tb.table_type = 'BASE TABLE')
         and not exists (
           select 1 from pg_index i
             join pg_class tc on tc.oid = i.indrelid
             join pg_namespace n on n.oid = tc.relnamespace
             join pg_class ic on ic.oid = i.indexrelid
             join pg_am am on am.oid = ic.relam
             join pg_attribute a on a.attrelid = tc.oid and a.attnum = any(i.indkey)
            where n.nspname = c.table_schema and tc.relname = c.table_name
              and a.attname = c.column_name and am.amname = 'gist')`);
    expect(r.rows.map((x) => x.col)).toEqual([]);
    const all = await t().admin.query(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'farm' and udt_name = 'geometry'`,
    );
    expect(all.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  test('geometry and tstzrange round-trip through Drizzle as GeoJSON / {from,to}', async () => {
    const { db } = t();
    const { fieldId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION });
    const [row] = await db
      .select()
      .from(schema.fieldBoundaries)
      .where(eq(schema.fieldBoundaries.fieldId, fieldId));
    expect(row?.geom.type).toBe('MultiPolygon');
    const ring = row?.geom.coordinates[0]?.[0];
    expect(ring?.[0]?.[0]).toBeCloseTo(-84.06, 9);
    expect(row?.valid.from).toBeInstanceOf(Date);
    expect(row?.valid.to).toBeNull();
    const [viaSql] = await db
      .select({ g: asGeoJson(schema.fieldBoundaries.geom, { maxDecimals: 5 }) })
      .from(schema.fieldBoundaries)
      .where(eq(schema.fieldBoundaries.fieldId, fieldId));
    expect(viaSql?.g.type).toBe('MultiPolygon');
  });

  test('Point columns round-trip', async () => {
    const { db } = t();
    const [m] = await db
      .insert(schema.machines)
      .values({ kind: 'semi', unitNo: 'S1' })
      .returning({ id: schema.machines.id });
    if (!m) throw new Error('insert failed');
    const ts = new Date('2026-10-28T15:00:00Z');
    await db.insert(schema.machineState).values({
      machineId: m.id,
      ts,
      geom: { type: 'Point', coordinates: [-84.04, 41.9] },
      positionSource: 'eld',
      activity: 'transport',
      speedMph: 52.5,
    });
    const [s] = await db
      .select()
      .from(schema.machineState)
      .where(eq(schema.machineState.machineId, m.id));
    expect(s?.geom).toEqual({ type: 'Point', coordinates: [-84.04, 41.9] });
    expect(s?.ts.toISOString()).toBe(ts.toISOString());
  });
});

describe('farm_app privileges', () => {
  test('can SELECT, INSERT, UPDATE and DELETE app tables', async () => {
    const { pool } = t();
    const ins = await pool.query(
      `insert into farm.parties (kind, display_name, roles) values ('person', 'Dan', '{crew}') returning id`,
    );
    const id = ins.rows[0].id as string;
    await pool.query(`update farm.parties set phone = '555-0100' where id = $1`, [id]);
    const sel = await pool.query('select phone from farm.parties where id = $1', [id]);
    expect(sel.rows[0].phone).toBe('555-0100');
    await pool.query('delete from farm.parties where id = $1', [id]);
    for (const table of [
      'farm.machines',
      'farm.positions',
      'ingest.sync_state',
      'ingest.raw_events',
      'ingest.external_refs',
      'ingest.job_runs',
      'ingest.oauth_tokens',
      'app.settings',
      'app.topic_seq',
      'farm.current_boundaries',
    ]) {
      await expect(pool.query(`select count(*) from ${table}`)).resolves.toBeTruthy();
    }
    await pool.query(`insert into app.settings (key, value) values ('test.key', 'true'::jsonb)`);
    await pool.query(`delete from app.settings where key = 'test.key'`);
  });

  test.each([
    'create table farm.sneaky (id int)',
    'create table app.sneaky (id int)',
    'create table public.sneaky (id int)',
    'create table extensions.sneaky (id int)',
    'create schema sneaky',
    'alter table farm.parties add column sneaky int',
    'drop table farm.positions',
    'truncate farm.parties',
  ])('cannot: %s', async (sql) => {
    await expect(t().pool.query(sql)).rejects.toMatchObject({ code: '42501' });
  });

  test('cannot read the migrations journal', async () => {
    await expect(
      t().pool.query('select * from drizzle.__drizzle_migrations'),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('runs as farm_app with extensions on its search_path', async () => {
    const r = await t().pool.query(
      `select current_user as u, current_setting('search_path') as sp, ST_AsText(ST_MakePoint(1, 2)) as p`,
    );
    expect(r.rows[0]).toMatchObject({ u: 'farm_app', p: 'POINT(1 2)' });
    expect(r.rows[0].sp).toMatch(/extensions/);
    expect(getTableName(schema.parties)).toBe('parties');
  });
});
