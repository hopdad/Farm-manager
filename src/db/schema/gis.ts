/**
 * Schema `gis`: public reference data and the map layer registry (plan §4). M1 tables: soils
 * (1c), parcels and the layer registry (1d); CDL, CSB and terrain arrive in 1e.
 * SQL source of truth: db/migrations/0003_m1_see_it.sql (functions gis.rebuild_field_soils,
 * gis.rebuild_all_field_soils and the triggers live there). Keep imports relative (drizzle-kit
 * loads this file).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { CACHE_POLICIES, type LayerLegend, MAP_LAYER_FORMATS } from '../../domain/map-layers';
import type { SoilComponent } from '../../domain/soils';
import { geometryColumn } from '../geo';
import { fieldBoundaries } from './farm';

export const gis = pgSchema('gis');

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** SSURGO map units (1c): dominant component attributes and component-weighted NCCPI (0-1). */
export const soilMapunits = gis.table(
  'soil_mapunits',
  {
    mukey: text('mukey').primaryKey(),
    /** Survey area, e.g. 'MI091' (Lenawee), 'MI115' (Monroe). */
    areasymbol: text('areasymbol').notNull(),
    musym: text('musym'),
    muname: text('muname').notNull(),
    /** compname of the largest major component (the soil series shown in the panel). */
    dominantComponent: text('dominant_component'),
    drainageClass: text('drainage_class'),
    hydgrp: text('hydgrp'),
    farmlandClass: text('farmland_class'),
    nccpi: doublePrecision('nccpi'),
    components: jsonb('components').$type<SoilComponent[]>().notNull().default(sql`'[]'::jsonb`),
    /** Survey area version / tabular date of the load. */
    surveyVersion: text('survey_version'),
    loadedAt: tstz('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'soil_mapunits_nccpi_check',
      sql`${t.nccpi} is null or (${t.nccpi} >= 0 and ${t.nccpi} <= 1)`,
    ),
  ],
);

/**
 * SSURGO polygons (1c). `sourceId` is the loader's stable key (SDA mupolygonkey, or
 * `areasymbol:mukey:<sha8 of the geometry>`), so reloads converge. Valid geometries only.
 */
export const soilPolygons = gis.table(
  'soil_polygons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mukey: text('mukey')
      .notNull()
      .references(() => soilMapunits.mukey, { onDelete: 'cascade' }),
    areasymbol: text('areasymbol').notNull(),
    geom: geometryColumn('geom', 'MultiPolygon').notNull(),
    source: text('source').notNull().default('ssurgo'),
    sourceId: text('source_id').notNull(),
    loadedAt: tstz('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    unique('soil_polygons_source_source_id_key').on(t.source, t.sourceId),
    index('soil_polygons_mukey_idx').on(t.mukey),
    index('soil_polygons_geom_gist').using('gist', t.geom),
  ],
);

/**
 * Soils per boundary version (1c). Written ONLY by gis.rebuild_field_soils(boundary_id), which a
 * trigger runs on every new boundary version (and gis.rebuild_all_field_soils() after a load).
 */
export const fieldSoils = gis.table(
  'field_soils',
  {
    boundaryId: uuid('boundary_id')
      .notNull()
      .references(() => fieldBoundaries.id, { onDelete: 'cascade' }),
    mukey: text('mukey')
      .notNull()
      .references(() => soilMapunits.mukey, { onDelete: 'cascade' }),
    acres: numeric('acres', { precision: 12, scale: 4, mode: 'number' }).notNull(),
    /** Percent of the boundary's area, 0-100. */
    pct: numeric('pct', { precision: 7, scale: 4, mode: 'number' }).notNull(),
    computedAt: tstz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'field_soils_pkey', columns: [t.boundaryId, t.mukey] }),
    index('field_soils_mukey_idx').on(t.mukey),
    check('field_soils_acres_check', sql`${t.acres} >= 0`),
    check('field_soils_pct_check', sql`${t.pct} >= 0 and ${t.pct} <= 100`),
  ],
);

/** One parcel file as received (1d, D7): county, vendor or the synthetic fixture. */
export const parcelImports = gis.table(
  'parcel_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'synthetic', 'lenawee-county', a vendor name, … */
    source: text('source').notNull(),
    countyFips: text('county_fips'),
    receivedOn: date('received_on', { mode: 'string' }),
    licenseNote: text('license_note').notNull().default(''),
    fileName: text('file_name'),
    sha256: text('sha256'),
    featureCount: integer('feature_count'),
    importedAt: tstz('imported_at').notNull().defaultNow(),
    notes: text('notes'),
  },
  (t) => [
    check('parcel_imports_county_fips_check', sql`${t.countyFips} ~ '^[0-9]{5}$'`),
    check('parcel_imports_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Parcels with owners (1d). PRIVATE data: only the private parcels MVT and session-checked
 * routes read it. One row per (county, parcel number); `importId` is the latest import that
 * wrote it. `gisAcres` is set by a trigger (geodesic area); `acres` is what the file says.
 */
export const parcels = gis.table(
  'parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => parcelImports.id, { onDelete: 'cascade' }),
    countyFips: text('county_fips').notNull(),
    parcelNo: text('parcel_no').notNull(),
    ownerName: text('owner_name'),
    ownerMailing: text('owner_mailing'),
    propertyAddress: text('property_address'),
    acres: numeric('acres', { precision: 12, scale: 4, mode: 'number' }),
    gisAcres: numeric('gis_acres', { precision: 12, scale: 4, mode: 'number' })
      .notNull()
      .default(0),
    attrs: jsonb('attrs').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    geom: geometryColumn('geom', 'MultiPolygon').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('parcels_county_fips_parcel_no_key').on(t.countyFips, t.parcelNo),
    index('parcels_import_id_idx').on(t.importId),
    index('parcels_geom_gist').using('gist', t.geom),
    check('parcels_county_fips_check', sql`${t.countyFips} ~ '^[0-9]{5}$'`),
  ],
);

/**
 * The map layer registry (1d): what is built and where. Drawing lives in code (LayerDef with the
 * same key, src/ui/map/layers). Rows for the MVT layers (fields, soils, parcels, tile_lines) come
 * with the migration; pmtiles/xyz rows are upserted by the gis:* CLIs after a build.
 */
export const mapLayers = gis.table(
  'map_layers',
  {
    key: text('key').primaryKey(),
    kind: text('kind', { enum: MAP_LAYER_FORMATS }).notNull(),
    urlOrKey: text('url_or_key').notNull(),
    version: text('version'),
    cachePolicy: text('cache_policy', { enum: CACHE_POLICIES }).notNull().default('public'),
    minzoom: integer('minzoom').notNull().default(0),
    maxzoom: integer('maxzoom').notNull().default(22),
    attribution: text('attribution'),
    legend: jsonb('legend').$type<LayerLegend>(),
    sourceVintage: text('source_vintage'),
    builtAt: tstz('built_at'),
    defaultVisible: boolean('default_visible').notNull().default(false),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('map_layers_key_check', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check('map_layers_kind_check', sql`${t.kind} in (${inList(MAP_LAYER_FORMATS)})`),
    check('map_layers_cache_policy_check', sql`${t.cachePolicy} in (${inList(CACHE_POLICIES)})`),
    check(
      'map_layers_zoom_check',
      sql`${t.minzoom} >= 0 and ${t.maxzoom} <= 24 and ${t.minzoom} <= ${t.maxzoom}`,
    ),
    check(
      'map_layers_version_check',
      sql`${t.version} is null or ${t.version} ~ '^[0-9A-Za-z_.-]{1,64}$'`,
    ),
  ],
);
