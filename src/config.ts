/**
 * src/config.ts: all configuration, zod-validated. THE ONLY MODULE THAT READS process.env
 * (Biome `noProcessEnv` + src/seams.test.ts enforce it).
 *
 * Env files are loaded with @next/env's `loadEnvConfig`, so tsx scripts, drizzle.config.ts and
 * tests see .env + .env.local exactly like Next does. One difference: Next skips .env.local when
 * NODE_ENV=test; we merge it anyway (never overriding), because the local database credentials
 * that DB tests need live there.
 *
 * Usage:
 *   const cfg = getConfig();            // server code, scripts (throws ConfigError with a fix-it message)
 *   getDevOrigins()                     // next.config.ts (never throws)
 *   publicConfig(getConfig())           // the client-safe subset, passed to client components as props
 *
 * Client components never read env: server components pass values down. (NEXT_PUBLIC_REALTIME is
 * still named NEXT_PUBLIC_ to match the plan; it is read here on the server.)
 *
 * Keep imports relative (no "@/"): drizzle-kit and next.config.ts load this file directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as nextEnvModule from '@next/env';
import { z } from 'zod';
import { CONNECTOR_MODES, type Mode } from './connectors/types';
import { SCENARIO_NAMES } from './sim/types';

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/.+/.test(v) && URL.canParse(v), 'must be a postgres:// URL');
const httpUrl = z.url({ protocol: /^https?$/ });
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const onOff = z.enum(['on', 'off']).transform((v) => v === 'on');
const connectorMode = z.enum(CONNECTOR_MODES).default('sim');
const hex = (chars: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${chars}}$`), `must be ${chars} hex characters`);

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const baseSchema = z.object({
  /** development | test | production. `next start` on the PC is still development (pilot). */
  APP_ENV: z.enum(APP_ENVS).default('development'),

  // --- database -------------------------------------------------------------------------------
  /** App connection, as farm_app. Locally postgres://farm_app:…@127.0.0.1:15432/postgres. */
  DATABASE_URL: postgresUrl,
  /** Migrations/admin connection, as postgres (session pooler in production). Scripts only. */
  DATABASE_URL_MIGRATE: postgresUrl.optional(),
  /** Host port of the local container (compose reads it from .env). */
  DB_PORT: int(1, 65535).default(15432),
  /** postgres password of the local container (compose reads it from .env). Scripts only. */
  DB_PASSWORD: z.string().min(1).optional(),
  /** farm_app login password, applied by `pnpm db:configure local`. Scripts only. */
  FARM_APP_PASSWORD: z.string().min(1).optional(),
  /** Max connections of the page-request pool. */
  DB_POOL_MAX: int(1, 100).default(10),
  /** Max connections of the jobs pool (kept small so a sync never starves page requests). */
  DB_JOBS_POOL_MAX: int(1, 20).default(2),

  // --- app ------------------------------------------------------------------------------------
  /** Base URL people use; cookie `Secure` follows its scheme, never NODE_ENV. */
  PUBLIC_URL: httpUrl.default('http://localhost:3000'),
  /** Comma list for Next's allowedDevOrigins (LAN IPs + <hostname>.local), written by env:init. */
  DEV_ORIGINS: csv,
  /** Bearer secret for POST /api/jobs/<name>. */
  JOBS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Signs the local session cookie (jose). */
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** AES-256-GCM key (64 hex) for ingest.oauth_tokens.ciphertext. Required in production. */
  TOKEN_ENC_KEY: hex(64).optional(),
  AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  /** Client realtime adapter: sse (local /api/realtime) | supabase (Broadcast). */
  NEXT_PUBLIC_REALTIME: z.enum(['sse', 'supabase']).default('sse'),
  BASEMAP_STYLE: z.enum(['protomaps-local', 'openfreemap']).default('protomaps-local'),
  /** Local storage adapter root (relative to the project). */
  STORAGE_DIR: z.string().min(1).default('.data/storage'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- jobs clock -----------------------------------------------------------------------------
  /** croner = tools/clock; pgcron = rehearse the production path (pg_cron + pg_net in the container). */
  CLOCK: z.enum(['croner', 'pgcron']).default('croner'),
  /** Which `host` values this clock fires (shop-PC worker after MD: 'pc'). */
  CLOCK_HOSTS: z
    .string()
    .default('app,pc')
    .transform((v, ctx) => {
      const hosts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const h of hosts) {
        if (h !== 'app' && h !== 'pc')
          ctx.addIssue({ code: 'custom', message: `unknown host '${h}'` });
      }
      return hosts as ('app' | 'pc')[];
    }),
  /**
   * Local demo cadence: tools/clock fires jobs that declare `demoEvery` at that interval
   * (fleet.trucks every 5 s instead of 30 s). Only with sim/replay/off connectors; never in
   * production. `pnpm env:init` turns it on for the PC demo.
   */
  JOBS_DEMO_CADENCE: onOff.default(false),
  /**
   * A machine whose latest fix is older than this is `stale` (plan 1a: 10 min). Applies to
   * sources that report continuously (ELD, cab device, manual).
   */
  FLEET_STALE_SECONDS: int(5, 86_400).default(600),
  /**
   * The same for machines whose latest fix came from Deere (`deere_working`): Deere only records
   * positions while a machine is working, so an idle cart has no new fix for minutes at a time.
   */
  FLEET_STALE_SECONDS_DEERE: int(5, 86_400).default(600),

  // --- connectors -----------------------------------------------------------------------------
  /**
   * Vendor stand-in base URL; sim-mode clients use `${VENDOR_SIM_URL}/<vendor>`. Loopback only
   * (the stand-in never listens on the LAN, and sim-mode traffic never leaves the PC).
   */
  VENDOR_SIM_URL: httpUrl
    .refine(
      (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname),
      'the vendor stand-in is loopback-only: use http://127.0.0.1:<port>',
    )
    .default('http://127.0.0.1:4010'),
  CONNECTOR_DEERE: connectorMode,
  CONNECTOR_ELD: connectorMode,
  CONNECTOR_WEATHER: connectorMode,
  ELD_VENDOR: z.enum(['samsara', 'motive']).default('samsara'),
  /** Deere Work Plan push. Off by default: the PC can never push to the real org. */
  WRITEBACK_DEERE: onOff.default(false),
  DEERE_CLIENT_ID: z.string().min(1).optional(),
  DEERE_CLIENT_SECRET: z.string().min(1).optional(),
  SAMSARA_API_TOKEN: z.string().min(1).optional(),
  MOTIVE_API_KEY: z.string().min(1).optional(),
  /** NWS requires a User-Agent with contact info. */
  NWS_USER_AGENT: z.string().min(1).default('farm-manager (local development)'),

  // --- simulator ------------------------------------------------------------------------------
  SIM_SCENARIO: z.enum(SCENARIO_NAMES).default('harvest-day'),
  SIM_SEED: int(0, 2_147_483_647).default(1),
  /** Sim seconds per wall second. */
  SIM_SPEED: z.coerce.number().positive().max(3600).default(1),
  /** Freeze sim time at this ISO instant (deterministic screenshots and tests). */
  SIM_FROZEN_AT: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
});

const configSchema = baseSchema.superRefine((c, ctx) => {
  const modes: [string, Mode][] = [
    ['CONNECTOR_DEERE', c.CONNECTOR_DEERE],
    ['CONNECTOR_ELD', c.CONNECTOR_ELD],
    ['CONNECTOR_WEATHER', c.CONNECTOR_WEATHER],
  ];
  if (c.JOBS_DEMO_CADENCE) {
    const real = modes.filter(([, m]) => m === 'sandbox' || m === 'live').map(([k]) => k);
    if (c.APP_ENV === 'production' || real.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['JOBS_DEMO_CADENCE'],
        message:
          c.APP_ENV === 'production'
            ? 'not allowed in production'
            : `only for sim/replay/off connectors (${real.join(', ')} talk to a real vendor): set JOBS_DEMO_CADENCE=off`,
      });
    }
  }
  if (c.APP_ENV !== 'production') return;
  for (const [key, mode] of modes) {
    if (mode === 'sim' || mode === 'replay') {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `'${mode}' is not allowed when APP_ENV=production (use live, sandbox or off)`,
      });
    }
  }
  if (c.SIM_FROZEN_AT) {
    ctx.addIssue({ code: 'custom', path: ['SIM_FROZEN_AT'], message: 'not allowed in production' });
  }
  if (!c.TOKEN_ENC_KEY) {
    ctx.addIssue({ code: 'custom', path: ['TOKEN_ENC_KEY'], message: 'required in production' });
  }
  if (!c.PUBLIC_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_URL'],
      message: 'must be https:// in production',
    });
  }
  if (c.NEXT_PUBLIC_REALTIME === 'sse') {
    ctx.addIssue({
      code: 'custom',
      path: ['NEXT_PUBLIC_REALTIME'],
      message: "'sse' is local-only; use 'supabase' in production",
    });
  }
});

type ParsedEnv = z.infer<typeof baseSchema>;

export interface Config extends ParsedEnv {
  /** Project root the env files were loaded from. */
  projectDir: string;
  isProduction: boolean;
  /** Cookie `Secure` flag: follows PUBLIC_URL's scheme. */
  cookieSecure: boolean;
}

/** Keys the schema knows about (for docs and tests). */
export const CONFIG_KEYS = Object.keys(baseSchema.shape) as (keyof ParsedEnv)[];

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `Invalid configuration:\n  - ${issues.join('\n  - ')}\n` +
        'Run `pnpm env:init` to create .env and .env.local, or fix the values above.',
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EnvLike = Record<string, string | undefined>;

/** Pure: validate an env-like object. Empty strings count as unset. */
export function parseConfig(env: EnvLike, projectDir: string = process.cwd()): Config {
  const input: EnvLike = {};
  for (const key of CONFIG_KEYS) {
    const v = env[key];
    input[key] = v === '' ? undefined : v;
  }
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`),
    );
  }
  const c = result.data;
  return {
    ...c,
    projectDir,
    isProduction: c.APP_ENV === 'production',
    cookieSecure: c.PUBLIC_URL.startsWith('https://'),
  };
}

// ---------------------------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------------------------

type NextEnvModule = typeof import('@next/env');
// @next/env is CommonJS without detectable named exports: under Node ESM only `default` exists.
const nextEnv: NextEnvModule =
  (nextEnvModule as unknown as { default?: NextEnvModule }).default ?? nextEnvModule;

const quietLog = { info: () => {}, error: (...args: unknown[]) => console.error(...args) };
let loadedDir: string | null = null;

/**
 * Load .env* files into process.env like Next does (existing variables win).
 * Idempotent per process; the first projectDir wins (Next caches the same way).
 */
export function loadEnvFiles(projectDir: string = process.cwd()): void {
  if (loadedDir !== null) return;
  loadedDir = projectDir;
  const nodeEnv = process.env.NODE_ENV;
  nextEnv.loadEnvConfig(projectDir, nodeEnv !== 'production', quietLog);
  if (nodeEnv === 'test') {
    const local = path.join(projectDir, '.env.local');
    if (existsSync(local)) {
      const parsed = parseEnv(readFileSync(local, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  }
}

let cached: Config | null = null;

/** The validated config (memoized). Throws ConfigError with a readable, fix-it message. */
export function getConfig(): Config {
  if (cached) return cached;
  const dir = process.cwd();
  loadEnvFiles(dir);
  cached = parseConfig(process.env, dir);
  return cached;
}

/** Like getConfig but returns the error instead of throwing (health checks, dry runs). */
export function tryGetConfig(): { ok: true; config: Config } | { ok: false; error: ConfigError } {
  try {
    return { ok: true, config: getConfig() };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, error: e };
    throw e;
  }
}

/** For next.config.ts: Next's allowedDevOrigins. Never throws (a fresh clone has no .env.local). */
export function getDevOrigins(): string[] {
  loadEnvFiles(process.cwd());
  return csv.parse(process.env.DEV_ORIGINS ?? '');
}

/** The admin/migrations URL (postgres role). Throws a fix-it message when missing. */
export function getMigrateUrl(): string {
  const url = tryGetMigrateUrl();
  if (!url) {
    throw new ConfigError(['DATABASE_URL_MIGRATE: required for database scripts']);
  }
  return url;
}

/** The admin URL if configured (no validation of the rest of the config). */
export function tryGetMigrateUrl(): string | undefined {
  loadEnvFiles(process.cwd());
  const v = process.env.DATABASE_URL_MIGRATE;
  return v ? postgresUrl.parse(v) : undefined;
}

/** Settings for playwright.config.ts (test tooling, not app config). */
export interface E2eSettings {
  /** E2E_BASE_URL, else PUBLIC_URL (so a parallel agent's own port is used), else localhost:3000. */
  baseURL: string;
  /** CI is set to anything but '', '0' or 'false' (GitHub Actions sets CI=true). */
  ci: boolean;
  /** E2E_BASE_URL was given: test that app as is (no webServer). */
  external: boolean;
}

/** Pure: E2E settings from an env-like object. Throws ConfigError only for a malformed E2E_BASE_URL. */
export function parseE2eSettings(env: EnvLike): E2eSettings {
  const explicit = env.E2E_BASE_URL?.trim();
  let baseURL = 'http://localhost:3000';
  if (explicit) {
    const r = httpUrl.safeParse(explicit);
    if (!r.success) throw new ConfigError(['E2E_BASE_URL: must be an http(s) URL']);
    baseURL = r.data;
  } else {
    const pub = httpUrl.safeParse(env.PUBLIC_URL?.trim());
    if (pub.success) baseURL = pub.data;
  }
  const ciRaw = (env.CI ?? '').trim().toLowerCase();
  return { baseURL, ci: ciRaw !== '' && ciRaw !== '0' && ciRaw !== 'false', external: !!explicit };
}

/**
 * For playwright.config.ts: loads the env files like everything else (so .env.development.local
 * overrides apply) and never needs the app's secrets, so it works in a fresh clone.
 */
export function getE2eSettings(): E2eSettings {
  loadEnvFiles(process.cwd());
  return parseE2eSettings(process.env);
}

/** Client-safe subset. Server components pass it to client components as props. */
export interface PublicConfig {
  appEnv: AppEnv;
  realtime: 'sse' | 'supabase';
  basemapStyle: 'protomaps-local' | 'openfreemap';
  /** FLEET_STALE_SECONDS (ELD, cab device, manual fixes). */
  staleAfterSeconds: number;
  /** FLEET_STALE_SECONDS_DEERE (Deere working-only fixes). */
  deereStaleAfterSeconds: number;
}
export function publicConfig(c: Config): PublicConfig {
  return {
    appEnv: c.APP_ENV,
    realtime: c.NEXT_PUBLIC_REALTIME,
    basemapStyle: c.BASEMAP_STYLE,
    staleAfterSeconds: c.FLEET_STALE_SECONDS,
    deereStaleAfterSeconds: c.FLEET_STALE_SECONDS_DEERE,
  };
}

/**
 * Environment for a child process: the current environment plus overrides
 * (`undefined` removes a key). Scripts use this instead of touching process.env.
 */
export function childEnv(overrides: EnvLike = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Test-only: forget the memoized config (env files stay loaded). */
export function resetConfigCache(): void {
  cached = null;
}
