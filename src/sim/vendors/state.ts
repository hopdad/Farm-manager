/**
 * The stand-in's persisted state (.data/vendor-sim/state.json): scenario, clock timeline,
 * control-API faults and the Deere OAuth grants it has issued (so a stand-in restart doesn't
 * log the app out). Feed pages are computed from the world, never stored.
 *
 * Pure data + helpers; the file I/O lives in tools/vendor-sim/state-file.ts and the tests use
 * `memoryStateStore()`.
 */
import { z } from 'zod';
import { type FaultRule, SCENARIO_NAMES, type ScenarioName, type SimClockState } from '../types';
import type { ClockTimeline } from './clock';
import { faultRuleInputSchema } from './faults';

export const VENDOR_SIM_STATE_VERSION = 1;

/** An OAuth grant the Deere stand-in issued (authorization code, access or refresh token). */
export interface IssuedGrant {
  clientId: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
}
export interface IssuedCode extends IssuedGrant {
  redirectUri: string;
}

export interface DeereOAuthState {
  codes: Record<string, IssuedCode>;
  accessTokens: Record<string, IssuedGrant>;
  /** Rotating: a refresh token is deleted when used; reusing it is `invalid_grant`. */
  refreshTokens: Record<string, IssuedGrant>;
}

export interface VendorSimState {
  version: typeof VENDOR_SIM_STATE_VERSION;
  scenario: ScenarioName;
  seed: number;
  clock: ClockTimeline;
  faults: FaultRule[];
  deere: DeereOAuthState;
}

/** Where the server keeps its state between restarts. */
export interface StateStore {
  load(): VendorSimState | null;
  save(state: VendorSimState): void;
}

export function emptyDeereOAuth(): DeereOAuthState {
  return { codes: {}, accessTokens: {}, refreshTokens: {} };
}

const iso = z.iso.datetime({ offset: true });
const grant = z.object({ clientId: z.string(), scope: z.string(), issuedAt: iso, expiresAt: iso });
const clockState: z.ZodType<SimClockState> = z.object({
  anchorWall: iso,
  anchorSim: iso,
  speed: z.number().positive(),
  paused: z.boolean(),
});

/** Validates a loaded state.json (anything else is ignored and the stand-in starts fresh). */
export const vendorSimStateSchema = z.object({
  version: z.literal(VENDOR_SIM_STATE_VERSION),
  scenario: z.enum(SCENARIO_NAMES),
  seed: z.number().int().min(0),
  clock: z.array(clockState).min(1),
  faults: z.array(faultRuleInputSchema.extend({ id: z.string().min(1) })),
  deere: z.object({
    codes: z.record(z.string(), grant.extend({ redirectUri: z.string() })),
    accessTokens: z.record(z.string(), grant),
    refreshTokens: z.record(z.string(), grant),
  }),
});

export function parseVendorSimState(value: unknown): VendorSimState | null {
  const r = vendorSimStateSchema.safeParse(value);
  return r.success ? (r.data as VendorSimState) : null;
}

/** Drop expired codes and tokens (called before each save). */
export function pruneGrants(deere: DeereOAuthState, wallNow: Date): DeereOAuthState {
  const live = <T extends IssuedGrant>(m: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(m).filter(([, g]) => Date.parse(g.expiresAt) > wallNow.getTime()),
    ) as Record<string, T>;
  return {
    codes: live(deere.codes),
    accessTokens: live(deere.accessTokens),
    refreshTokens: live(deere.refreshTokens),
  };
}

/** In-memory store (tests, `--no-persist`). */
export function memoryStateStore(initial: VendorSimState | null = null): StateStore & {
  current: VendorSimState | null;
  saves: number;
} {
  const store = {
    current: initial ? structuredClone(initial) : null,
    saves: 0,
    load() {
      return store.current ? structuredClone(store.current) : null;
    },
    save(state: VendorSimState) {
      store.current = structuredClone(state);
      store.saves++;
    },
  };
  return store;
}
