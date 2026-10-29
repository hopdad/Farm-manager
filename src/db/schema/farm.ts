/**
 * Schema `farm`: the operation itself (plan §4 core tables: M0 plus the M1 1a-1d tables).
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
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  APP_ROLES,
  DEVICE_KINDS,
  DEVICE_ROLES,
  GEOFENCE_KINDS,
  LINEAGE_KINDS,
  PARTY_KINDS,
  PARTY_ROLES,
  SOIL_TEMP_SOURCES,
  TENURES,
  TILE_LINE_KINDS,
  TILE_LINE_ORIGINS,
} from '../../domain/farm';
import { ACTIVITIES, MACHINE_KINDS, MACHINE_STATUSES, POSITION_SOURCES } from '../../domain/fleet';
import type { SprayReason, WeatherStation } from '../../domain/weather';
import { SPRAY_VERDICTS } from '../../domain/weather';
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
    /** When `notes` was last edited from the field panel (1a). */
    notesUpdatedAt: tstz('notes_updated_at'),
    notesUpdatedBy: uuid('notes_updated_by').references((): AnyPgColumn => appUsers.id, {
      onDelete: 'set null',
    }),
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
    /** When the machine was marked down (1a); null while active. */
    downAt: tstz('down_at'),
    downBy: uuid('down_by').references((): AnyPgColumn => appUsers.id, { onDelete: 'set null' }),
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

// =============================================================================================
// M1 (db/migrations/0003_m1_see_it.sql)
// =============================================================================================

/**
 * A person who can sign in (1a). `authUserId` links the Supabase Auth user at the first
 * verified sign-in in production (MD). `pinHash` is the operator PIN (scrypt; the format
 * belongs to src/platform/auth), with `failedPins` / `lockedUntil` lockout in both
 * environments. Bumping `sessionEpoch` signs the person out everywhere.
 */
export const appUsers = farm.table(
  'app_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    role: text('role', { enum: APP_ROLES }).notNull(),
    authUserId: uuid('auth_user_id'),
    pinHash: text('pin_hash'),
    pinSetAt: tstz('pin_set_at'),
    failedPins: integer('failed_pins').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    sessionEpoch: integer('session_epoch').notNull().default(0),
    active: boolean('active').notNull().default(true),
    lastSignInAt: tstz('last_sign_in_at'),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('app_users_party_id_key').on(t.partyId),
    unique('app_users_auth_user_id_key').on(t.authUserId),
    unique('app_users_source_source_id_key').on(t.source, t.sourceId),
    check('app_users_role_check', sql`${t.role} in (${inList(APP_ROLES)})`),
    check('app_users_failed_pins_check', sql`${t.failedPins} >= 0`),
    check('app_users_session_epoch_check', sql`${t.sessionEpoch} >= 0`),
  ],
);

/**
 * An enrolled screen (1a). Shared kinds (wall, cab/truck iPad) carry a device session plus an
 * operator PIN layer; a phone is personal (`appUserId`). `role` is what the device session may
 * do on its own (never manager/owner). Local enrollment stores only the one-time code's hash
 * and expiry; `revokedAt` or a `sessionEpoch` bump invalidates the device's cookies.
 */
export const devices = farm.table(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: DEVICE_KINDS }).notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: DEVICE_ROLES }).notNull().default('viewer'),
    appUserId: uuid('app_user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    authUserId: uuid('auth_user_id'),
    enrollCodeHash: text('enroll_code_hash'),
    enrollExpiresAt: tstz('enroll_expires_at'),
    enrolledAt: tstz('enrolled_at'),
    sessionEpoch: integer('session_epoch').notNull().default(0),
    lastSeenAt: tstz('last_seen_at'),
    revokedAt: tstz('revoked_at'),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('devices_auth_user_id_key').on(t.authUserId),
    unique('devices_source_source_id_key').on(t.source, t.sourceId),
    uniqueIndex('devices_enroll_code_hash_key')
      .on(t.enrollCodeHash)
      .where(sql`${t.enrollCodeHash} is not null`),
    check('devices_kind_check', sql`${t.kind} in (${inList(DEVICE_KINDS)})`),
    check('devices_role_check', sql`${t.role} in (${inList(DEVICE_ROLES)})`),
    check('devices_session_epoch_check', sql`${t.sessionEpoch} >= 0`),
  ],
);

/** Geofence enter/exit per machine (1a), computed from positions; one open visit at a time. */
export const geofenceVisits = farm.table(
  'geofence_visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    geofenceId: uuid('geofence_id')
      .notNull()
      .references(() => geofences.id, { onDelete: 'cascade' }),
    enteredAt: tstz('entered_at').notNull(),
    exitedAt: tstz('exited_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('geofence_visits_machine_id_geofence_id_entered_at_key').on(
      t.machineId,
      t.geofenceId,
      t.enteredAt,
    ),
    uniqueIndex('geofence_visits_open_key')
      .on(t.machineId, t.geofenceId)
      .where(sql`${t.exitedAt} is null`),
    index('geofence_visits_geofence_id_entered_at_idx').on(t.geofenceId, t.enteredAt.desc()),
    check(
      'geofence_visits_exit_after_entry_check',
      sql`${t.exitedAt} is null or ${t.exitedAt} >= ${t.enteredAt}`,
    ),
  ],
);

/** Cached NWS grid cells (1b): id '<WFO>/<x>,<y>'; `stations` nearest first. */
export const weatherGrids = farm.table(
  'weather_grids',
  {
    id: text('id').primaryKey(),
    wfo: text('wfo').notNull(),
    gridX: integer('grid_x').notNull(),
    gridY: integer('grid_y').notNull(),
    stations: jsonb('stations').$type<WeatherStation[]>().notNull().default(sql`'[]'::jsonb`),
    geom: geometryColumn('geom', 'Polygon'),
    timeZone: text('time_zone'),
    lookedUpAt: tstz('looked_up_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('weather_grids_wfo_grid_x_grid_y_key').on(t.wfo, t.gridX, t.gridY),
    index('weather_grids_geom_gist').using('gist', t.geom),
    check(
      'weather_grids_id_check',
      sql`${t.id} = ${t.wfo} || '/' || ${t.gridX} || ',' || ${t.gridY}`,
    ),
  ],
);

/** Which grid cell a field's weather comes from (1b), looked up from a point in its boundary. */
export const fieldWeatherGrids = farm.table(
  'field_weather_grids',
  {
    fieldId: uuid('field_id')
      .primaryKey()
      .references(() => fields.id, { onDelete: 'cascade' }),
    gridId: text('grid_id')
      .notNull()
      .references(() => weatherGrids.id, { onDelete: 'cascade' }),
    point: geometryColumn('point', 'Point').notNull(),
    lookedUpAt: tstz('looked_up_at').notNull().defaultNow(),
  },
  (t) => [index('field_weather_grids_point_gist').using('gist', t.point)],
);

/** NWS hourly forecast per grid cell and issue (1b). PK (grid_id, issued_at, valid_at). */
export const weatherForecasts = farm.table(
  'weather_forecasts',
  {
    gridId: text('grid_id')
      .notNull()
      .references(() => weatherGrids.id, { onDelete: 'cascade' }),
    issuedAt: tstz('issued_at').notNull(),
    /** Start of the hour (UTC). */
    validAt: tstz('valid_at').notNull(),
    tempF: doublePrecision('temp_f'),
    dewpointF: doublePrecision('dewpoint_f'),
    rhPct: doublePrecision('rh_pct'),
    windMph: doublePrecision('wind_mph'),
    gustMph: doublePrecision('gust_mph'),
    windDir: doublePrecision('wind_dir'),
    popPct: doublePrecision('pop_pct'),
    qpfIn: doublePrecision('qpf_in'),
    skyPct: doublePrecision('sky_pct'),
    mixingHeightFt: doublePrecision('mixing_height_ft'),
    transportWindMph: doublePrecision('transport_wind_mph'),
    source: text('source').notNull().default('nws'),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'weather_forecasts_pkey', columns: [t.gridId, t.issuedAt, t.validAt] }),
    index('weather_forecasts_grid_id_valid_at_idx').on(t.gridId, t.validAt, t.issuedAt.desc()),
    check(
      'weather_forecasts_wind_dir_check',
      sql`${t.windDir} is null or (${t.windDir} >= 0 and ${t.windDir} <= 360)`,
    ),
    check(
      'weather_forecasts_pct_check',
      sql`(${t.popPct} is null or ${t.popPct} between 0 and 100) and (${t.skyPct} is null or ${t.skyPct} between 0 and 100) and (${t.rhPct} is null or ${t.rhPct} between 0 and 100)`,
    ),
  ],
);

/** NWS station observations (1b). PK (station_id, observed_at). */
export const weatherObservations = farm.table(
  'weather_observations',
  {
    stationId: text('station_id').notNull(),
    observedAt: tstz('observed_at').notNull(),
    geom: geometryColumn('geom', 'Point'),
    tempF: doublePrecision('temp_f'),
    dewpointF: doublePrecision('dewpoint_f'),
    rhPct: doublePrecision('rh_pct'),
    windMph: doublePrecision('wind_mph'),
    gustMph: doublePrecision('gust_mph'),
    windDir: doublePrecision('wind_dir'),
    precipLastHourIn: doublePrecision('precip_last_hour_in'),
    source: text('source').notNull().default('nws'),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'weather_observations_pkey', columns: [t.stationId, t.observedAt] }),
    index('weather_observations_geom_gist').using('gist', t.geom),
    check(
      'weather_observations_wind_dir_check',
      sql`${t.windDir} is null or (${t.windDir} >= 0 and ${t.windDir} <= 360)`,
    ),
  ],
);

/** Soil temperature readings (1b: manual probe readings from a phone; D5 source in 2b). */
export const soilTempReadings = farm.table(
  'soil_temp_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id').references(() => fields.id, { onDelete: 'set null' }),
    observedAt: tstz('observed_at').notNull(),
    depthIn: doublePrecision('depth_in').notNull().default(2),
    tempF: doublePrecision('temp_f').notNull(),
    source: text('source', { enum: SOIL_TEMP_SOURCES }).notNull().default('manual'),
    sourceId: text('source_id'),
    geom: geometryColumn('geom', 'Point'),
    enteredBy: uuid('entered_by').references(() => appUsers.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('soil_temp_readings_source_source_id_key').on(t.source, t.sourceId),
    index('soil_temp_readings_field_id_observed_at_idx').on(t.fieldId, t.observedAt.desc()),
    index('soil_temp_readings_geom_gist').using('gist', t.geom),
    check('soil_temp_readings_source_check', sql`${t.source} in (${inList(SOIL_TEMP_SOURCES)})`),
    check('soil_temp_readings_depth_in_check', sql`${t.depthIn} > 0 and ${t.depthIn} <= 72`),
    check('soil_temp_readings_temp_f_check', sql`${t.tempF} between -40 and 140`),
  ],
);

/**
 * Every spray go/no-go call (1b, advisory): verdict, reasons, inputs, rules version and the
 * forecast issue used. Unique (field, hour, rules version, forecast issue), nulls not distinct.
 */
export const sprayAssessments = farm.table(
  'spray_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    /** Start of the assessed hour (UTC, whole hour: CHECKed). */
    forHour: tstz('for_hour').notNull(),
    verdict: text('verdict', { enum: SPRAY_VERDICTS }).notNull(),
    reasons: jsonb('reasons').$type<SprayReason[]>().notNull().default(sql`'[]'::jsonb`),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    rulesVersion: text('rules_version').notNull(),
    forecastIssuedAt: tstz('forecast_issued_at'),
    gridId: text('grid_id'),
    assessedAt: tstz('assessed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('spray_assessments_run_key')
      .on(t.fieldId, t.forHour, t.rulesVersion, t.forecastIssuedAt)
      .nullsNotDistinct(),
    index('spray_assessments_field_id_for_hour_idx').on(
      t.fieldId,
      t.forHour.desc(),
      t.assessedAt.desc(),
    ),
    check('spray_assessments_verdict_check', sql`${t.verdict} in (${inList(SPRAY_VERDICTS)})`),
    check(
      'spray_assessments_for_hour_check',
      sql`mod(extract(epoch from ${t.forHour})::numeric, 3600) = 0`,
    ),
  ],
);

/** Field splits and merges (1c), so history follows a field through boundary edits. */
export const fieldLineage = farm.table(
  'field_lineage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentFieldId: uuid('parent_field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    childFieldId: uuid('child_field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: LINEAGE_KINDS }).notNull(),
    effectiveOn: date('effective_on', { mode: 'string' }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('field_lineage_parent_field_id_child_field_id_key').on(t.parentFieldId, t.childFieldId),
    index('field_lineage_child_field_id_idx').on(t.childFieldId),
    check('field_lineage_kind_check', sql`${t.kind} in (${inList(LINEAGE_KINDS)})`),
    check('field_lineage_not_self_check', sql`${t.parentFieldId} <> ${t.childFieldId}`),
  ],
);

/**
 * "Change this in Ops Center" notes (1c, D6): an attempted edit of a Deere-mastered boundary,
 * with the shape the person drew. Resolved once the change is made in Operations Center.
 */
export const boundaryChangeRequests = farm.table(
  'boundary_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    proposedGeom: geometryColumn('proposed_geom', 'MultiPolygon'),
    note: text('note').notNull(),
    requestedBy: uuid('requested_by').references(() => appUsers.id, { onDelete: 'set null' }),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => appUsers.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
  },
  (t) => [
    index('boundary_change_requests_open_idx').on(t.fieldId).where(sql`${t.resolvedAt} is null`),
    index('boundary_change_requests_proposed_geom_gist').using('gist', t.proposedGeom),
    check(
      'boundary_change_requests_resolution_check',
      sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`,
    ),
  ],
);

/** Drainage tile as-builts (1d): imported or drawn. Private on the map. */
export const tileLines = farm.table(
  'tile_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id').references(() => fields.id, { onDelete: 'set null' }),
    geom: geometryColumn('geom', 'MultiLineString').notNull(),
    kind: text('kind', { enum: TILE_LINE_KINDS }).notNull().default('lateral'),
    sizeIn: numeric('size_in', { precision: 5, scale: 2, mode: 'number' }),
    depthFt: numeric('depth_ft', { precision: 5, scale: 2, mode: 'number' }),
    installedOn: date('installed_on', { mode: 'string' }),
    origin: text('origin', { enum: TILE_LINE_ORIGINS }).notNull(),
    installer: text('installer'),
    notes: text('notes'),
    source: text('source').notNull().default('app'),
    sourceId: text('source_id'),
    /** File name or "drawn by …". */
    sourceRef: text('source_ref'),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('tile_lines_source_source_id_key').on(t.source, t.sourceId),
    index('tile_lines_field_id_idx').on(t.fieldId),
    index('tile_lines_geom_gist').using('gist', t.geom),
    check('tile_lines_kind_check', sql`${t.kind} in (${inList(TILE_LINE_KINDS)})`),
    check('tile_lines_origin_check', sql`${t.origin} in (${inList(TILE_LINE_ORIGINS)})`),
    check('tile_lines_size_in_check', sql`${t.sizeIn} is null or ${t.sizeIn} > 0`),
    check('tile_lines_depth_ft_check', sql`${t.depthFt} is null or ${t.depthFt} > 0`),
  ],
);
