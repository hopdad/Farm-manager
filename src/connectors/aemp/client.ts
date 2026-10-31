/**
 * The generic ISO 15143-3 (AEMP 2.0) client (docs/contracts-1f.md part B, fleet.aemp): one client
 * for every configured provider (AEMP_PROVIDERS; sim: the stand-in's `kubota` and `samsara`).
 *
 *  - Snapshot: `GET {baseUrl}/Fleet/{pageNumber}` from page 1 (100 machines a page, the page size
 *    is the provider's), following `Links` until a page has no `next` (aemp.md §1.4: "stop on a
 *    missing next, not on a short page"). The next page's URL is REBUILT from our own `baseUrl`
 *    with the page number the `next` href ends in: an href's host is never trusted (Deere's
 *    examples point at sandboxapi.com, Samsara's omit /beta).
 *  - `Accept` from the provider's format (`AempEndpoint.accept`); the body parsed by `format`
 *    (`auto`: by Content-Type), JSON or XML alike (./parse.ts).
 *  - Pacing: a provider is polled at most every `minIntervalSeconds` (Deere 3600: its feed is
 *    cached for an hour; Trackunit ≥ 960: one request per URL per 15 min; default 900). fleet.aemp
 *    runs every 15 min and skips providers polled more recently (the cursor keeps each one's last
 *    poll; a 10 s slack absorbs the scheduler's jitter).
 *  - Snapshot diff (src/connectors/sync-models.ts `pollSnapshotDiff`, mode `newer`): the key is
 *    `<provider>:<machine id>:<section>`, the version each section's own `datetime`, so a poll
 *    emits only the sections that moved (an unchanged hourly snapshot emits nothing).
 *  - Faults: a provider's fault series when it has one (`faultsPath`, e.g. Trackunit's
 *    `/Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}`), per machine, over (last window
 *    end, now] (a first window looks back a day; Trackunit allows 14 days at most); a 404 is
 *    read as "no faults" (some servers answer so: doc-derived, confirm).
 *  - Auth: ./auth.ts (every style; a subscription key with any of them).
 * A provider that fails is reported and retried on the next run; the poll fails only when every
 * provider that was due failed (so one dealer's outage never hides another provider's machines).
 */
import { type AempEndpoint, aempEndpoints, type ConnectorConfig, replayFetch } from '../endpoints';
import { VendorHttpError, VendorResponseError, vendorFetch } from '../http';
import { pollSnapshotDiff } from '../sync-models';
import type { Mode, PollResult, RawItem } from '../types';
import { AempAuth, type AempHttpOptions, type DeereGrant } from './auth';
import type { AempFaultRaw, AempFleetRaw } from './mapper';
import {
  type AempDropped,
  type AempFleetPage,
  AempParseError,
  aempBodyValue,
  connectionsLink,
  nextPageNumber,
  parseFaultPage,
  parseFleetPage,
} from './parse';
import { AEMP_SECTIONS, type AempEquipment, type AempFaultCode } from './schemas';

/** Pages followed per snapshot (or fault window) before giving up (a runaway `next` loop). */
export const AEMP_MAX_PAGES = 50;
/** A first fault window looks back this far. */
export const AEMP_FAULT_LOOKBACK_MS = 24 * 3_600_000;
/** The widest fault window asked for (Trackunit: at most 14 days). */
export const AEMP_MAX_FAULT_WINDOW_MS = 14 * 86_400_000;
/** A provider counts as due this much before its interval is up (scheduler jitter). */
export const AEMP_PACING_SLACK_MS = 10_000;

/** One provider's place in the fleet stream's cursor. */
export interface AempFleetProviderState {
  /** Start of the last successful poll (UTC ISO). */
  polledAt?: string;
  /** Its snapshot-diff cursor (src/connectors/sync-models.ts). */
  seen?: string;
  /** Short reason the last poll failed (no secrets). */
  error?: string;
  /** Something a person must do (Deere's `connections` link: approve the org). */
  note?: string;
}

export interface AempFleetCursor {
  v: 1;
  providers: Record<string, AempFleetProviderState>;
}

export interface AempFaultsCursor {
  v: 1;
  providers: Record<string, { polledAt?: string; machines: Record<string, string> }>;
}

function parseCursor<T extends { v: 1; providers: Record<string, unknown> }>(
  cursor: string | null,
): T {
  if (cursor?.startsWith('{')) {
    try {
      const v = JSON.parse(cursor) as Partial<T>;
      if (v.v === 1 && v.providers && typeof v.providers === 'object') return v as T;
    } catch {
      // start over
    }
  }
  return { v: 1, providers: {} } as unknown as T;
}

export const parseAempFleetCursor = (c: string | null) => parseCursor<AempFleetCursor>(c);
export const parseAempFaultsCursor = (c: string | null) => parseCursor<AempFaultsCursor>(c);

/** `2026-10-31T12:00:00Z` (the path form of an ISO window bound). */
export const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const shortError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? `${m.slice(0, 197)}...` : m;
};

export interface AempPollResult<T> extends PollResult<RawItem<T>> {
  /** Providers that failed this poll (the poll itself still succeeded). */
  failed: { provider: string; error: string }[];
}

export interface AempClientOptions {
  endpoints: AempEndpoint[];
  http?: AempHttpOptions;
  /** The Deere connection's grant (providers with auth `deere_oauth`). */
  deere?: DeereGrant | null;
  /** Told about every machine, section or fault item the schemas dropped. */
  onDropped?: (provider: string, dropped: AempDropped) => void;
}

export class AempClient {
  readonly endpoints: AempEndpoint[];
  private readonly http: AempHttpOptions;
  private readonly auth: AempAuth;
  private readonly onDropped: (provider: string, dropped: AempDropped) => void;

  constructor(opts: AempClientOptions) {
    this.endpoints = opts.endpoints;
    this.http = opts.http ?? {};
    this.auth = new AempAuth({ http: this.http, deere: opts.deere ?? null });
    this.onDropped =
      opts.onDropped ??
      ((provider, d) =>
        console.warn(
          `[aemp] ${provider}: dropped ${d.what}${d.id ? ` of ${d.id}` : ''}: ${d.reason}`,
        ));
  }

  /**
   * The client for a connector mode (AEMP_PROVIDERS through `aempEndpoints`). Replay is this same
   * client with the fixture transport (./replay.ts; JSON bodies only: XML providers are tested
   * through the stand-in and the parser's unit tests).
   */
  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    opts: Omit<AempClientOptions, 'endpoints'> = {},
  ): AempClient {
    const http = opts.http ?? {};
    return new AempClient({
      ...opts,
      endpoints: aempEndpoints(mode, cfg),
      http: mode === 'replay' ? { ...http, fetch: replayFetch('aemp', { now: http.now }) } : http,
    });
  }

  private now(): number {
    return (this.http.now ?? (() => new Date()))().getTime();
  }

  /** One authenticated GET; a 401 is retried once when the auth style can renew. */
  private async get(ep: AempEndpoint, url: string): Promise<{ body: string; type: string | null }> {
    const send = async (headers: Record<string, string>) => {
      const res = await vendorFetch(
        url,
        { method: 'GET', headers: { accept: ep.accept, ...headers } },
        { ...this.http, vendor: 'aemp' },
      );
      return { body: await res.text(), type: res.headers.get('content-type') };
    };
    const headers = await this.auth.headers(ep);
    try {
      return await send(headers);
    } catch (e) {
      if (
        e instanceof VendorHttpError &&
        e.status === 401 &&
        (await this.auth.renew(ep, headers))
      ) {
        return send(await this.auth.headers(ep));
      }
      throw e;
    }
  }

  private value(ep: AempEndpoint, url: string, r: { body: string; type: string | null }): unknown {
    try {
      return aempBodyValue(r.body, r.type, ep.format);
    } catch (e) {
      if (e instanceof AempParseError) {
        throw new VendorResponseError('aemp', new URL(url).pathname, e.message);
      }
      throw e;
    }
  }

  /** `GET {baseUrl}/Fleet/{pageNumber}`, parsed. */
  async fleetPage(ep: AempEndpoint, pageNumber: number): Promise<AempFleetPage> {
    const url = `${ep.baseUrl}/Fleet/${pageNumber}`;
    const value = this.value(ep, url, await this.get(ep, url));
    try {
      return parseFleetPage(value, ep.idElement);
    } catch (e) {
      if (e instanceof AempParseError) {
        throw new VendorResponseError('aemp', new URL(url).pathname, e.message);
      }
      throw e;
    }
  }

  /** Every page of a provider's snapshot (pages rebuilt from `baseUrl`, see the header). */
  async fleetSnapshot(ep: AempEndpoint): Promise<{
    machines: { id: string; equipment: AempEquipment; snapshotTime: string | null }[];
    pages: number;
    connections: string | null;
  }> {
    const machines: { id: string; equipment: AempEquipment; snapshotTime: string | null }[] = [];
    let connections: string | null = null;
    let pageNumber = 1;
    let pages = 0;
    for (;;) {
      const page = await this.fleetPage(ep, pageNumber);
      pages++;
      for (const d of page.dropped) this.onDropped(ep.id, d);
      for (const m of page.machines) machines.push({ ...m, snapshotTime: page.snapshotTime });
      connections ??= connectionsLink(page.links);
      const next = nextPageNumber(page.links);
      // A `next` without a usable page number moves one on; one that doesn't move on stops.
      const hasNext = page.links.some((l) => l.rel === 'next');
      if (!hasNext) break;
      const n = next ?? pageNumber + 1;
      if (n <= pageNumber || pages >= AEMP_MAX_PAGES) break;
      pageNumber = n;
    }
    return { machines, pages, connections };
  }

  /** The provider's fault series URL for one machine and window (`faultsPath`), or null. */
  faultsUrl(ep: AempEndpoint, machineId: string, startMs: number, endMs: number, page: number) {
    if (!ep.faultsPath) return null;
    // One encoding of the id ('/' → %2F: Trackunit answers 404 to a raw slash).
    const path = ep.faultsPath
      .replaceAll('{id}', encodeURIComponent(machineId))
      .replaceAll('{start}', isoSeconds(startMs))
      .replaceAll('{end}', isoSeconds(endMs))
      .replaceAll('{page}', String(page));
    return `${ep.baseUrl}${path}`;
  }

  /** Every FaultCode occurrence of one machine in [start, end] (empty when none or 404). */
  async machineFaults(
    ep: AempEndpoint,
    machineId: string,
    startMs: number,
    endMs: number,
  ): Promise<AempFaultCode[]> {
    const out: AempFaultCode[] = [];
    let page = 1;
    for (let n = 0; n < AEMP_MAX_PAGES; n++) {
      const url = this.faultsUrl(ep, machineId, startMs, endMs, page);
      if (!url) return out;
      let r: { body: string; type: string | null };
      try {
        r = await this.get(ep, url);
      } catch (e) {
        // doc-derived, confirm: some ISO servers answer 404 for "no faults in this window"
        // (Trackunit's importer has a flag for it: faultCodesAcceptHttpNotFoundAsEmptyData).
        if (e instanceof VendorHttpError && e.status === 404) return out;
        throw e;
      }
      let parsed: ReturnType<typeof parseFaultPage>;
      try {
        parsed = parseFaultPage(this.value(ep, url, r));
      } catch (e) {
        if (e instanceof AempParseError) {
          throw new VendorResponseError('aemp', new URL(url).pathname, e.message);
        }
        throw e;
      }
      for (const d of parsed.dropped) this.onDropped(ep.id, { ...d, id: machineId });
      out.push(...parsed.items);
      const next = nextPageNumber(parsed.links);
      if (!parsed.links.some((l) => l.rel === 'next')) break;
      const p = next ?? page + 1;
      if (p <= page) break;
      page = p;
    }
    return out;
  }

  private due(polledAt: string | undefined, ep: AempEndpoint, now: number): boolean {
    if (!polledAt) return true;
    const t = Date.parse(polledAt);
    return !Number.isFinite(t) || now - t >= ep.minIntervalSeconds * 1000 - AEMP_PACING_SLACK_MS;
  }

  /**
   * One poll of the fleet stream: every provider that is due, its snapshot diffed against the
   * cursor; raw items = one per machine whose sections moved (header + the moved sections).
   */
  async pollFleet(cursor: string | null): Promise<AempPollResult<AempFleetRaw>> {
    const now = this.now();
    const prev = parseAempFleetCursor(cursor);
    const next: AempFleetCursor = { v: 1, providers: {} };
    const items: RawItem<AempFleetRaw>[] = [];
    const failed: { provider: string; error: string }[] = [];
    let due = 0;
    let firstError: unknown = null;
    for (const ep of this.endpoints) {
      const st = prev.providers[ep.id] ?? {};
      next.providers[ep.id] = st;
      if (!this.due(st.polledAt, ep, now)) continue;
      due++;
      try {
        const snap = await this.fleetSnapshot(ep);
        const sections = snap.machines.flatMap((m) =>
          AEMP_SECTIONS.flatMap((s) => {
            const sec = m.equipment[s];
            if (!sec) return [];
            return [{ m, s, ms: Date.parse(sec.datetime ?? m.snapshotTime ?? '') }];
          }),
        );
        const diff = await pollSnapshotDiff({
          cursor: st.seen ?? null,
          fetchSnapshot: async () => sections,
          keyOf: (x) => `${ep.id}:${x.m.id}:${x.s}`,
          versionOf: (x) => x.ms,
          mode: 'newer',
          maxKeys: 30_000,
        });
        const byMachine = new Map<string, { raw: AempFleetRaw; latest: number }>();
        for (const x of diff.items) {
          const hit = byMachine.get(x.m.id) ?? {
            raw: {
              provider: ep.id,
              machineId: x.m.id,
              snapshotTime: x.m.snapshotTime,
              equipment: { EquipmentHeader: x.m.equipment.EquipmentHeader },
            },
            latest: 0,
          };
          (hit.raw.equipment as Record<string, unknown>)[x.s] = x.m.equipment[x.s];
          hit.latest = Math.max(hit.latest, x.ms);
          byMachine.set(x.m.id, hit);
        }
        for (const { raw, latest } of byMachine.values()) {
          items.push({
            externalId: `${ep.id}:${raw.machineId}@${new Date(latest).toISOString()}`,
            payload: raw,
          });
        }
        next.providers[ep.id] = {
          polledAt: new Date(now).toISOString(),
          seen: diff.cursor,
          ...(snap.connections
            ? {
                note: `Deere lists no organization for this app yet: approve it at ${snap.connections}`,
              }
            : {}),
        };
      } catch (e) {
        if (this.http.signal?.aborted) throw e;
        firstError ??= e;
        failed.push({ provider: ep.id, error: shortError(e) });
        next.providers[ep.id] = { ...st, error: shortError(e) };
      }
    }
    if (due > 0 && failed.length === due) throw firstError;
    return { items, cursor: JSON.stringify(next), failed };
  }

  /**
   * One poll of the faults stream: for every provider with a fault series that is due, each of
   * its machines (`machines[provider]`: the ids the app maps) over (its last window end, now].
   */
  async pollFaults(
    cursor: string | null,
    machines: Readonly<Record<string, readonly string[]>>,
  ): Promise<AempPollResult<AempFaultRaw>> {
    const now = this.now();
    const prev = parseAempFaultsCursor(cursor);
    const next: AempFaultsCursor = { v: 1, providers: {} };
    const items: RawItem<AempFaultRaw>[] = [];
    const failed: { provider: string; error: string }[] = [];
    let due = 0;
    let firstError: unknown = null;
    for (const ep of this.endpoints) {
      if (!ep.faultsPath) continue;
      const st = prev.providers[ep.id] ?? { machines: {} };
      const done: Record<string, string> = { ...st.machines };
      next.providers[ep.id] = { ...st, machines: done };
      if (!this.due(st.polledAt, ep, now)) continue;
      due++;
      try {
        let complete = true;
        for (const id of machines[ep.id] ?? []) {
          if (this.http.deadline && this.now() >= this.http.deadline.getTime()) {
            complete = false;
            break;
          }
          const last = Date.parse(done[id] ?? '');
          const start = Math.max(
            Number.isFinite(last) ? last : now - AEMP_FAULT_LOOKBACK_MS,
            now - AEMP_MAX_FAULT_WINDOW_MS,
          );
          for (const fault of await this.machineFaults(ep, id, start, now)) {
            items.push({
              externalId: `${ep.id}:${id}:${fault.datetime}:${fault.CodeIdentifier}`,
              payload: { provider: ep.id, machineId: id, fault },
            });
          }
          done[id] = new Date(now).toISOString();
        }
        next.providers[ep.id] = {
          machines: done,
          ...(complete ? { polledAt: new Date(now).toISOString() } : { polledAt: st.polledAt }),
        };
      } catch (e) {
        if (this.http.signal?.aborted) throw e;
        firstError ??= e;
        failed.push({ provider: ep.id, error: shortError(e) });
      }
    }
    if (due > 0 && failed.length === due) throw firstError;
    return { items, cursor: JSON.stringify(next), failed };
  }
}
