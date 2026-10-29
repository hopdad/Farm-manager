/**
 * What every vendor route of the stand-in receives: the world, the clock, the request's matched
 * faults, the mutable persisted state and a few knobs. Built per request by ./server.ts.
 */
import type { FaultRule, SimVendor, SimWorld } from '../types';
import type { SimRequest, SimResponse } from './http';
import type { VendorSimState } from './state';

export interface VendorSimTuning {
  /** Samsara GPS sample spacing (wall ms, epoch-aligned grid). */
  gpsIntervalMs: number;
  /** Samsara stats sample spacing (wall ms). */
  statsIntervalMs: number;
  /** Deere breadcrumb spacing while working (wall ms). */
  breadcrumbIntervalMs: number;
  /** A feed cursor older than this resumes from now − this (wall ms). */
  maxFeedCatchUpMs: number;
  /** Most location (or stat) events in one Samsara feed page, across vehicles. */
  maxEventsPerPage: number;
  /** Deere access-token lifetime (short, so the locked refresh path runs every few minutes). */
  accessTokenTtlSeconds: number;
  /** Deere refresh-token lifetime. */
  refreshTokenTtlSeconds: number;
  /** Deere authorization-code lifetime. */
  authCodeTtlSeconds: number;
  /** Deere breadcrumbs: furthest back a startDate may reach (wall ms). */
  deereMaxLookbackMs: number;
}

export const DEFAULT_TUNING: VendorSimTuning = {
  gpsIntervalMs: 5_000,
  statsIntervalMs: 60_000,
  breadcrumbIntervalMs: 10_000,
  maxFeedCatchUpMs: 30 * 60_000,
  maxEventsPerPage: 512,
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 30 * 86_400,
  authCodeTtlSeconds: 120,
  deereMaxLookbackMs: 60 * 60_000,
};

/** Counters the in-process tests read (also served by GET /_control/stats). */
export interface VendorSimCounters {
  requests: Record<string, number>;
  /** Successful token-endpoint exchanges by grant type. */
  tokenGrants: { authorization_code: number; refresh_token: number };
  /** Requests answered with a fault, by kind. */
  faults: Record<string, number>;
}

export interface VendorContext {
  readonly vendor: SimVendor;
  readonly world: SimWorld;
  readonly tuning: VendorSimTuning;
  /** Wall clock (injectable in tests). */
  now(): Date;
  /** Sim time at a wall instant (clock timeline, contracts §9 time rule). */
  simAt(wall: Date): Date;
  /** Fault rules that apply to THIS request (already rolled). */
  readonly faults: readonly FaultRule[];
  /** Wall time a rule was first seen active (token_expired / token_revoked cut-offs). */
  ruleStart(rule: FaultRule): Date;
  /** Mutable persisted state; call persist() after changing it. */
  readonly state: VendorSimState;
  persist(): void;
  /** Previous page served per feed key (duplicate_page fault). In memory only. */
  readonly lastPages: Map<string, { after: string | null; body: unknown }>;
  readonly counters: VendorSimCounters;
  /** Opaque random token. */
  newToken(bytes?: number): string;
  log(msg: string): void;
}

export interface VendorModule {
  vendor: SimVendor;
  handle(req: SimRequest, ctx: VendorContext): SimResponse | Promise<SimResponse>;
  /** Vendor-shaped error reply (http_error, rate_limit faults and the module's own errors). */
  error(status: number, message: string, headers?: Record<string, string>): SimResponse;
}
