/**
 * This season's field operations in the field panel's History tab (slice 1f, deere-ops;
 * docs/contracts-1f.md §5.1): what the tab shows and how it stays current, framework-free
 * (./operations-section.tsx renders it; ./operations.test.ts drives it with fakes).
 *
 *  - Text: kind, crop, dates (America/Detroit), acres reported and inside the field, the
 *    measured yield, moisture and speed, products with their rates (ADAPT unit ids in words),
 *    machines and operator, provisional vs final, coverage or not.
 *  - Loader: GET /api/fields/<id>/operations (`fieldOperationsUrl`), refetched on realtime
 *    `fields`/`updated` for this field with part 'operations', on `fields`/`invalidate` and on
 *    every resync, and polled while realtime can't deliver. The response names the realtime
 *    adapter and the app's environment in two headers (OPERATIONS_REALTIME_HEADER,
 *    OPERATIONS_APP_ENV_HEADER), so the tab subscribes without reading config (tabs get no
 *    config: src/ui/fields/tabs.ts); never two requests at once, stale answers dropped.
 */
import { FARM_TIME_ZONE } from '../../domain/farm';
import {
  type FieldOperationsResponse,
  fieldOperationsUrl,
  type OperationKind,
  type OperationProduct,
  type OperationView,
} from '../../domain/operations';
import type { RealtimeClient } from '../../platform/realtime/types';

/** Response header naming the realtime adapter ('sse' | 'supabase'). */
export const OPERATIONS_REALTIME_HEADER = 'x-farm-realtime';
/** Response header naming the app's environment (the e2e realtime seam is non-production only). */
export const OPERATIONS_APP_ENV_HEADER = 'x-farm-app-env';

export const OPERATION_KIND_LABELS: Record<OperationKind, string> = {
  seeding: 'Planting',
  application: 'Application',
  harvest: 'Harvest',
  tillage: 'Tillage',
};

const SOURCE_LABELS: Record<string, string> = { deere: 'Ops Center', app: 'typed in' };

const UNIT_WORDS: Record<string, string> = { prcnt: '%', 'mi1hr-1': 'mph', 'km1hr-1': 'km/h' };

/** ADAPT unit ids (Deere's) as people write them: 'seeds1ac-1' → 'seeds/ac', 'floz1ac-1' → 'fl oz/ac'. */
export function unitText(unitId: string | null): string {
  if (!unitId) return '';
  return (
    UNIT_WORDS[unitId] ??
    unitId
      .replace(/^floz/, 'fl oz')
      .replace(/1ac-1$/, '/ac')
      .replace(/1ha-1$/, '/ha')
  );
}

const num = (v: number, digits = 1) =>
  v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** One product: 'NF 108-22 · 34,000 seeds/ac' (rate, else total). */
export function productText(p: OperationProduct): string {
  if (p.rate !== null) return `${p.name} · ${num(p.rate, 2)} ${unitText(p.rateUnit)}`.trim();
  if (p.total !== null) return `${p.name} · ${num(p.total, 1)} ${unitText(p.totalUnit)}`.trim();
  return p.name;
}

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  month: 'short',
  day: 'numeric',
});
const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: FARM_TIME_ZONE });

/** 'May 6', or 'Oct 15–16' / 'Oct 31 – Nov 2' when it spans days (local dates). */
export function dateRangeText(startedAt: string, endedAt: string | null): string {
  const a = new Date(startedAt);
  const from = DAY.format(a);
  if (!endedAt) return `${from} (still running)`;
  const b = new Date(endedAt);
  if (DAY_KEY.format(a) === DAY_KEY.format(b)) return from;
  const to = DAY.format(b);
  const [m1] = from.split(' ');
  const [m2, d2] = to.split(' ');
  return m1 === m2 ? `${from}–${d2}` : `${from} – ${to}`;
}

/**
 * '152.4 ac' (reported), with the part inside the field when clearly less (1 % and 0.1 ac:
 * Deere's acres and the app's geodesic ones differ by a rounding anyway).
 */
export function acresText(o: Pick<OperationView, 'areaReportedAc' | 'areaClippedAc'>): string {
  const r = o.areaReportedAc;
  const c = o.areaClippedAc;
  if (r === null && c === null) return 'acres not reported';
  if (r === null) return `${num(c as number)} ac in the field`;
  if (c === null || r - c < Math.max(0.1, r * 0.01)) return `${num(r)} ac`;
  return `${num(r)} ac (${num(c)} in the field)`;
}

/** The measured totals: '182.7 bu/ac · 27,551 bu · 18.4% moisture · 4.5 mph'. */
export function measurementsText(o: Pick<OperationView, 'measurements'>): string {
  const m = o.measurements;
  const parts: string[] = [];
  if (m.yieldBuAc !== undefined) parts.push(`${num(m.yieldBuAc)} bu/ac`);
  if (m.totalBu !== undefined) parts.push(`${num(m.totalBu, 0)} bu`);
  if (m.moisturePct !== undefined) parts.push(`${num(m.moisturePct)}% moisture`);
  if (m.avgSpeedMph !== undefined) parts.push(`${num(m.avgSpeedMph)} mph`);
  return parts.join(' · ');
}

/** 'C1, C2 · Dale Mercer'. */
export function machinesText(o: Pick<OperationView, 'machines' | 'operatorName'>): string {
  const units = o.machines.map((m) => m.unitNo).join(', ');
  return [units, o.operatorName].filter(Boolean).join(' · ');
}

/** Everything one row of the tab says (tests and the component share it). */
export interface OperationRowText {
  title: string;
  dates: string;
  acres: string;
  measurements: string;
  products: string[];
  machines: string;
  coverage: string;
  status: string;
  source: string;
}

export function operationRowText(o: OperationView): OperationRowText {
  return {
    title: `${OPERATION_KIND_LABELS[o.kind]}${o.crop ? ` · ${o.crop}` : ''}`,
    dates: dateRangeText(o.startedAt, o.endedAt),
    acres: acresText(o),
    measurements: measurementsText(o),
    products: o.products.map(productText),
    machines: machinesText(o),
    coverage: o.hasCoverage ? 'coverage mapped' : 'no coverage map',
    status: o.status === 'final' ? 'final' : 'may still change',
    source: SOURCE_LABELS[o.source] ?? o.source,
  };
}

// ---------------------------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------------------------

export type OperationsStatus = 'loading' | 'ready' | 'not_found' | 'denied' | 'error';

export interface OperationsState {
  fieldId: string;
  status: OperationsStatus;
  data: FieldOperationsResponse | null;
  /** Why the last request failed (the last data stays on screen). */
  error: string | null;
}

export type RealtimeResolver = (headers: { realtime: string | null; appEnv: string | null }) => {
  client: RealtimeClient;
  connected(): boolean;
} | null;

export interface OperationsLoaderOptions {
  fieldId: string;
  fetch: typeof fetch;
  /** Builds the realtime client from the response's headers (null: poll only). */
  realtime: RealtimeResolver;
  onState(s: OperationsState): void;
  /** Poll interval while realtime can't deliver (default 30 s). */
  pollMs?: number;
  /** Refetches within this window collapse into one (default 300 ms; 0 in tests). */
  debounceMs?: number;
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
  };
}

export interface OperationsLoader {
  refetch(): void;
  stop(): void;
}

const browserTimers = {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function isResponse(v: unknown, fieldId: string): v is FieldOperationsResponse {
  const r = v as FieldOperationsResponse | null;
  return (
    !!r && r.fieldId === fieldId && typeof r.cropYear === 'number' && Array.isArray(r.operations)
  );
}

export function startFieldOperations(o: OperationsLoaderOptions): OperationsLoader {
  const timers = o.timers ?? browserTimers;
  let state: OperationsState = { fieldId: o.fieldId, status: 'loading', data: null, error: null };
  let stopped = false;
  let inflight: AbortController | null = null;
  let again = false;
  let debounce: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let connected: () => boolean = () => false;
  let lastText: string | null = null;

  const emit = (next: Partial<OperationsState>) => {
    state = { ...state, ...next };
    if (!stopped) o.onState(state);
  };

  const subscribe = (res: Response) => {
    if (unsubscribe) return;
    const rt = o.realtime({
      realtime: res.headers.get(OPERATIONS_REALTIME_HEADER),
      appEnv: res.headers.get(OPERATIONS_APP_ENV_HEADER),
    });
    if (!rt) return;
    connected = rt.connected;
    unsubscribe = rt.client.subscribe(
      'fields',
      (evt) => {
        if (
          evt.event === 'updated' &&
          evt.payload.fieldId === o.fieldId &&
          evt.payload.parts.includes('operations')
        ) {
          refetch();
        }
      },
      { onResync: () => refetch() },
    );
  };

  async function load(): Promise<void> {
    if (stopped) return;
    if (inflight) {
      again = true;
      return;
    }
    const ctrl = new AbortController();
    inflight = ctrl;
    try {
      const res = await o.fetch(fieldOperationsUrl(o.fieldId), {
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (stopped) return;
      if (res.ok) {
        const text = await res.text();
        if (stopped) return;
        subscribe(res);
        if (text === lastText && state.status === 'ready') {
          if (state.error) emit({ error: null });
        } else {
          const body = JSON.parse(text) as unknown;
          if (!isResponse(body, o.fieldId)) throw new Error('unexpected response');
          lastText = text;
          emit({ status: 'ready', data: body, error: null });
        }
      } else if (res.status === 404) {
        emit({ status: 'not_found', data: null, error: null });
      } else if (res.status === 401 || res.status === 403) {
        emit({ status: 'denied', data: null, error: null });
      } else {
        emit({
          status: state.data ? 'ready' : 'error',
          error: `the server answered ${res.status}`,
        });
      }
    } catch (e) {
      if (stopped || ctrl.signal.aborted) return;
      emit({
        status: state.data ? 'ready' : 'error',
        error:
          e instanceof Error && e.message === 'unexpected response' ? e.message : 'no connection',
      });
    } finally {
      if (inflight === ctrl) inflight = null;
      if (!stopped && again) {
        again = false;
        void load();
      }
    }
  }

  function refetch(): void {
    if (stopped) return;
    const ms = o.debounceMs ?? 300;
    if (ms <= 0) {
      void load();
      return;
    }
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => {
      debounce = null;
      void load();
    }, ms);
  }

  void load();
  const poll = timers.setInterval(() => {
    if (!connected()) void load();
  }, o.pollMs ?? 30_000);

  return {
    refetch,
    stop() {
      stopped = true;
      inflight?.abort();
      timers.clearInterval(poll);
      if (debounce !== null) timers.clearTimeout(debounce);
      unsubscribe?.();
    },
  };
}
