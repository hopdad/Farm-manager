/**
 * Schema `farm`: the operation itself (plan §4 core tables, M0 subset).
 * The SQL source of truth is db/migrations (custom SQL); this file mirrors it for typed queries.
 * src/db/schema.db.test.ts fails if a column here doesn't exist in the migrated database.
 *
 * Conventions: uuid PKs; timestamptz; acres as numeric; geometry in EPSG:4326 (GeoJSON in TS);
 * outside-source rows carry `source` + `source_id` (unique together) and a deterministic id
 * (src/domain/ids.ts). Keep imports relative: drizzle-kit loads this file directly.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { GEOFENCE_KINDS, PARTY_KINDS, PARTY_ROLES, TENURES } from '../../domain/farm';
import { ACTIVITIES, MACHINE_KINDS, MACHINE_STATUSES, POSITION_SOURCES } from '../../domain/fleet';
import { geometryColumn } from '../geo';
import { tstzrange } from '../range';

export const farm = pgSchema('farm');

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const parties = farm.table(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: PARTY_KINDS }).notNull(),
    orgId: uuid('org_id').references((): AnyPgColumn => parties.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    roles: text('roles', { enum: PARTY_ROLES }).array().notNull().default(sql`'{}'::text[]`),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    introducedBy: uuid('introduced_by').references((): AnyPgColumn => parties.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('parties_source_source_id_key').on(t.source, t.sourceId),
    index('parties_org_id_idx').on(t.orgId),
    check('parties_kind_check', sql`${t.kind} in (${inList(PARTY_KINDS)})`),
    check('parties_roles_check', sql`${t.roles} <@ array[${inList(PARTY_ROLES)}]::text[]`),
  ],
);

export const farms = farm.table(
  'farms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** null = your own operation; otherwise the custom-work customer. */
    clientPartyId: uuid('client_party_id').references(() => parties.id, { onDelete: 'set null' }),
    deereFarmId: text('deere_farm_id'),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('farms_source_source_id_key').on(t.source, t.sourceId)],
);

export const fields = farm.table(
  'fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    farmId: uuid('farm_id')
      .notNull()
      .references(() => farms.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    countyFips: text('county_fips'),
    tenure: text('tenure', { enum: TENURES }).notNull(),
    landlordPartyId: uuid('landlord_party_id').references(() => parties.id, {
      onDelete: 'set null',
    }),
    deereFieldId: text('deere_field_id'),
    active: boolean('active').notNull().default(true),
    notes: text('notes'),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('fields_source_source_id_key').on(t.source, t.sourceId),
    index('fields_farm_id_idx').on(t.farmId),
    check('fields_tenure_check', sql`${t.tenure} in (${inList(TENURES)})`),
    check('fields_county_fips_check', sql`${t.countyFips} ~ '^[0-9]{5}$'`),
  ],
);

/**
 * Boundary versions. `valid` is half-open [from, to); the current version has to = null.
 * EXCLUDE USING gist (field_id WITH =, valid WITH &&) (SQL only; Drizzle can't express it)
 * keeps versions of one field from overlapping. `acres` is set by a trigger from the geometry
 * (ST_Area(geom::geography) / 4046.86); never write it yourself.
 */
export const fieldBoundaries = farm.table(
  'field_boundaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    geom: geometryColumn('geom', 'MultiPolygon').notNull(),
    acres: numeric('acres', { precision: 12, scale: 4, mode: 'number' }).notNull().default(0),
    valid: tstzrange('valid').notNull().default(sql`tstzrange(now(), null, '[)')`),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    /** Free-text provenance: import file name, Deere boundary name, "drawn by …". */
    sourceRef: text('source_ref'),
    /** CDL/terrain stats need recomputing (gis.derived job, host 'pc'). */
    derivedStale: boolean('derived_stale').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('field_boundaries_source_source_id_key').on(t.source, t.sourceId),
    index('field_boundaries_geom_gist').using('gist', t.geom),
    check('field_boundaries_valid_not_empty', sql`not isempty(${t.valid})`),
  ],
);

/** View farm.current_boundaries: boundary versions whose `valid` contains now(). */
export const currentBoundaries = farm
  .view('current_boundaries', {
    id: uuid('id').notNull(),
    fieldId: uuid('field_id').notNull(),
    geom: geometryColumn('geom', 'MultiPolygon').notNull(),
    acres: numeric('acres', { precision: 12, scale: 4, mode: 'number' }).notNull(),
    valid: tstzrange('valid').notNull(),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    sourceRef: text('source_ref'),
    derivedStale: boolean('derived_stale').notNull(),
    createdAt: tstz('created_at').notNull(),
  })
  .existing();

export const fieldSeasons = farm.table(
  'field_seasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    cropYear: integer('crop_year').notNull(),
    crop: text('crop'),
    variety: text('variety'),
    plantedOn: date('planted_on', { mode: 'string' }),
    harvestedOn: date('harvested_on', { mode: 'string' }),
    yieldBuAc: numeric('yield_bu_ac', { precision: 8, scale: 2, mode: 'number' }),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('field_seasons_field_id_crop_year_key').on(t.fieldId, t.cropYear),
    unique('field_seasons_source_source_id_key').on(t.source, t.sourceId),
    check('field_seasons_crop_year_check', sql`${t.cropYear} between 1950 and 2100`),
  ],
);

export const machines = farm.table(
  'machines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: MACHINE_KINDS }).notNull(),
    unitNo: text('unit_no').notNull(),
    make: text('make'),
    model: text('model'),
    year: integer('year'),
    vinSerial: text('vin_serial'),
    status: text('status', { enum: MACHINE_STATUSES }).notNull().default('active'),
    downReason: text('down_reason'),
    engineHours: numeric('engine_hours', { precision: 10, scale: 1, mode: 'number' }),
    odometerMi: numeric('odometer_mi', { precision: 10, scale: 1, mode: 'number' }),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('machines_source_source_id_key').on(t.source, t.sourceId),
    check('machines_kind_check', sql`${t.kind} in (${inList(MACHINE_KINDS)})`),
    check('machines_status_check', sql`${t.status} in (${inList(MACHINE_STATUSES)})`),
  ],
);

/** Latest known state per machine (one row each), updated by the fleet jobs. */
export const machineState = farm.table(
  'machine_state',
  {
    machineId: uuid('machine_id')
      .primaryKey()
      .references(() => machines.id, { onDelete: 'cascade' }),
    /** Wall-clock time of the fix. */
    ts: tstz('ts').notNull(),
    geom: geometryColumn('geom', 'Point').notNull(),
    speedMph: doublePrecision('speed_mph'),
    heading: doublePrecision('heading'),
    activity: text('activity', { enum: ACTIVITIES }).notNull().default('idle'),
    currentFieldId: uuid('current_field_id').references(() => fields.id, { onDelete: 'set null' }),
    fuelPct: doublePrecision('fuel_pct'),
    engineOn: boolean('engine_on'),
    positionSource: text('position_source', { enum: POSITION_SOURCES }).notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('machine_state_geom_gist').using('gist', t.geom),
    check('machine_state_activity_check', sql`${t.activity} in (${inList(ACTIVITIES)})`),
    check(
      'machine_state_position_source_check',
      sql`${t.positionSource} in (${inList(POSITION_SOURCES)})`,
    ),
  ],
);

/** Raw position history (90 days, D9). PK (machine_id, ts); BRIN on ts. */
export const positions = farm.table(
  'positions',
  {
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    ts: tstz('ts').notNull(),
    geom: geometryColumn('geom', 'Point').notNull(),
    speedMph: doublePrecision('speed_mph'),
    heading: doublePrecision('heading'),
    engineOn: boolean('engine_on'),
    /** Vendor the fix came from: 'samsara', 'motive', 'deere', 'manual', … */
    source: text('source').notNull(),
  },
  (t) => [
    primaryKey({ name: 'positions_pkey', columns: [t.machineId, t.ts] }),
    index('positions_ts_brin').using('brin', t.ts),
    index('positions_geom_gist').using('gist', t.geom),
  ],
);

export const geofences = farm.table(
  'geofences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: GEOFENCE_KINDS }).notNull(),
    name: text('name').notNull(),
    /** Elevator / vendor party for elevator and fuel geofences. */
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    /** Field for field_entrance geofences. */
    fieldId: uuid('field_id').references(() => fields.id, { onDelete: 'cascade' }),
    geom: geometryColumn('geom', 'Polygon').notNull(),
    active: boolean('active').notNull().default(true),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('geofences_source_source_id_key').on(t.source, t.sourceId),
    index('geofences_geom_gist').using('gist', t.geom),
    check('geofences_kind_check', sql`${t.kind} in (${inList(GEOFENCE_KINDS)})`),
  ],
);
