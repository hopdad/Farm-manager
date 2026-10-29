/**
 * Fault injection for the vendor stand-in (contracts §9, plan §5 "Fault injection").
 *
 * Rules come from two places: the control API (`/_control/faults`, persisted) and the current
 * scenario's schedule (`scenarioFaultRules`, read-only: bad-morning's 6 a.m. outage, breakdown's
 * flaky trucks API). Per request the server asks `matchFaults()` which rules apply; the route
 * layers act on the kinds (outage/timeout drop the socket, latency delays, http_error and
 * rate_limit answer vendor-shaped errors, token_* reject tokens, duplicate_page/out_of_order
 * mangle feed pages, webhook_* apply to webhook delivery).
 *
 * `probability` is deterministic per (rule id, request sequence number), so a test that sends
 * the same requests in the same order sees the same faults.
 */
import { z } from 'zod';
import { FARM_TIME_ZONE } from '../../domain/farm';
import {
  FAULT_KINDS,
  type FaultKind,
  type FaultRule,
  type FaultsControlRequest,
  type ScenarioName,
  SIM_VENDORS,
  type SimVendor,
} from '../types';

const iso = z.iso.datetime({ offset: true });

/** Wire schema of a rule (control API input); `id` optional on add. */
export const faultRuleInputSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  vendor: z.enum([...SIM_VENDORS, '*']),
  pathPrefix: z.string().startsWith('/').max(256).optional(),
  kind: z.enum(FAULT_KINDS),
  probability: z.number().min(0).max(1).optional(),
  latencyMs: z.number().int().min(0).max(600_000).optional(),
  status: z.number().int().min(400).max(599).optional(),
  retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  from: iso.optional(),
  until: iso.optional(),
  simFrom: iso.optional(),
  simUntil: iso.optional(),
  label: z.string().max(120).optional(),
});

export const faultsControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('set'),
    rules: z.array(faultRuleInputSchema.extend({ id: z.string().min(1).max(64) })).max(100),
  }),
  z.strictObject({ action: z.literal('add'), rule: faultRuleInputSchema }),
  z.strictObject({ action: z.literal('remove'), id: z.string().min(1) }),
  z.strictObject({ action: z.literal('clear') }),
]);

/** Drop undefined keys so persisted rules stay tidy (and equal what the client sent). */
function tidy(rule: FaultRule): FaultRule {
  return Object.fromEntries(
    Object.entries(rule).filter(([, v]) => v !== undefined),
  ) as unknown as FaultRule;
}

/** Apply a control request to the control-API rule list. Throws on a duplicate id. */
export function applyFaultsRequest(
  rules: FaultRule[],
  req: FaultsControlRequest,
  newId: () => string,
): FaultRule[] {
  switch (req.action) {
    case 'set': {
      const ids = new Set<string>();
      for (const r of req.rules) {
        if (ids.has(r.id)) throw new FaultRequestError(`duplicate rule id '${r.id}'`);
        ids.add(r.id);
      }
      return req.rules.map(tidy);
    }
    case 'add': {
      const id = req.rule.id ?? newId();
      if (rules.some((r) => r.id === id)) throw new FaultRequestError(`rule '${id}' exists`);
      return [...rules, tidy({ ...req.rule, id })];
    }
    case 'remove':
      return rules.filter((r) => r.id !== req.id);
    case 'clear':
      return [];
    default: {
      const never: never = req;
      throw new FaultRequestError(`unknown faults action ${JSON.stringify(never)}`);
    }
  }
}

export class FaultRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultRequestError';
  }
}

export interface FaultRequestContext {
  vendor: SimVendor;
  /** Path below the vendor root, e.g. '/fleet/vehicles/locations/feed'. */
  path: string;
  wallNow: Date;
  simNow: Date;
  /** Per-vendor request sequence number (deterministic probability). */
  seq: number;
}

/** FNV-1a of `${ruleId}:${seq}` mapped to [0, 1). */
export function faultRoll(ruleId: string, seq: number): number {
  const s = `${ruleId}:${seq}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // One avalanche round so consecutive seqs spread out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

function inWindow(t: number, from?: string, until?: string): boolean {
  if (from && t < Date.parse(from)) return false;
  if (until && t >= Date.parse(until)) return false;
  return true;
}

/** Is the rule's time window open (wall and sim windows both, when given)? */
export function ruleActive(rule: FaultRule, wallNow: Date, simNow: Date): boolean {
  return (
    inWindow(wallNow.getTime(), rule.from, rule.until) &&
    inWindow(simNow.getTime(), rule.simFrom, rule.simUntil)
  );
}

/** Rules that apply to this request (vendor, path prefix, window, probability roll). */
export function matchFaults(rules: readonly FaultRule[], ctx: FaultRequestContext): FaultRule[] {
  return rules.filter((r) => {
    if (r.vendor !== '*' && r.vendor !== ctx.vendor) return false;
    if (r.pathPrefix && !ctx.path.startsWith(r.pathPrefix)) return false;
    if (!ruleActive(r, ctx.wallNow, ctx.simNow)) return false;
    const p = r.probability ?? 1;
    if (p >= 1) return true;
    if (p <= 0) return false;
    return faultRoll(r.id, ctx.seq) < p;
  });
}

/** The first matching rule of a kind (rules keep their list order: control API first). */
export function firstOfKind(rules: readonly FaultRule[], kind: FaultKind): FaultRule | undefined {
  return rules.find((r) => r.kind === kind);
}

// ---------------------------------------------------------------------------------------------
// Scenario schedules
// ---------------------------------------------------------------------------------------------

/** Offset (ms) of `tz` from UTC at instant `t` (local = utc + offset). */
function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant of local `hour:minute` in `tz` on the local calendar day of `day`. */
export function zonedInstant(day: Date, hour: number, minute = 0, tz = FARM_TIME_ZONE): Date {
  const localDay = new Date(day.getTime() + tzOffsetMs(day.getTime(), tz));
  const guess = Date.UTC(
    localDay.getUTCFullYear(),
    localDay.getUTCMonth(),
    localDay.getUTCDate(),
    hour,
    minute,
  );
  // Two passes settle the offset across a DST change.
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return new Date(t);
}

const at = (startsAt: Date, h: number, m = 0) => zonedInstant(startsAt, h, m).toISOString();

/**
 * Faults a scenario schedules, in SIM time on the scenario's local day (America/Detroit).
 * Ids are prefixed `scenario:` so they never collide with control-API rules.
 */
export function scenarioFaultRules(scenario: ScenarioName, startsAt: Date): FaultRule[] {
  switch (scenario) {
    case 'bad-morning':
      return [
        {
          id: 'scenario:internet-down',
          vendor: '*',
          kind: 'outage',
          simFrom: at(startsAt, 6, 0),
          simUntil: at(startsAt, 6, 45),
          label: 'internet down at 6 a.m.',
        },
        {
          id: 'scenario:deere-token-expired',
          vendor: 'deere',
          kind: 'token_expired',
          simFrom: at(startsAt, 7, 0),
          simUntil: at(startsAt, 7, 5),
          label: 'Deere tokens expire after the outage',
        },
        {
          id: 'scenario:samsara-rate-limit',
          vendor: 'samsara',
          kind: 'rate_limit',
          retryAfterSeconds: 30,
          simFrom: at(startsAt, 7, 15),
          simUntil: at(startsAt, 7, 25),
          label: 'Samsara rate limit (429) while catching up',
        },
      ];
    case 'breakdown':
      return [
        {
          id: 'scenario:samsara-flaky',
          vendor: 'samsara',
          kind: 'http_error',
          status: 500,
          probability: 0.2,
          label: 'trucks API flaky (20% 500s)',
        },
        {
          id: 'scenario:deere-slow',
          vendor: 'deere',
          kind: 'latency',
          latencyMs: 1500,
          label: 'Deere API slow (1.5 s)',
        },
      ];
    default:
      return [];
  }
}
