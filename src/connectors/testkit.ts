/**
 * Test helpers for the connector and fleet-job DB tests (not used by app code): a JobContext
 * over a test database, a LISTEN collector for app.publish notifications, and a seed of the
 * stand-in's stub farm (machines, a field with a boundary, the elevator geofence and exactly
 * the external refs `simExternalRefs()` lists, like the demo seed does for the real farm).
 */
import pg from 'pg';
import type { Db } from '../db/client';
import { upsertExternalRef } from '../db/external-refs';
import { farms, fieldBoundaries, fields, geofences, machines, parties } from '../db/schema';
import type { JobContext, JobLogger } from '../jobs/types';
import type { NotifyMessage } from '../platform/realtime/types';
import { type SimFarm, simExternalRefs } from '../sim/types';
import type { EldVendor } from './types';

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

export function collectingLogger(lines: LogLine[] = []): JobLogger & { lines: LogLine[] } {
  const at = (level: LogLine['level']) => (msg: string, data?: Record<string, unknown>) => {
    lines.push({ level, msg, data });
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export function testJobContext(
  db: { db: Db; pool: pg.Pool },
  opts: { name?: string; now?: () => Date; budgetMs?: number; signal?: AbortSignal } = {},
): JobContext & { log: JobLogger & { lines: LogLine[] } } {
  const now = opts.now ?? (() => new Date());
  return {
    name: opts.name ?? 'test.job',
    db: db.db,
    pool: db.pool,
    log: collectingLogger(),
    signal: opts.signal ?? new AbortController().signal,
    now,
    deadline: new Date(now().getTime() + (opts.budgetMs ?? 45_000)),
  };
}

/** LISTEN app_events on a dedicated client; `messages` fills as notifications arrive. */
export async function listenAppEvents(url: string): Promise<{
  messages: NotifyMessage[];
  of(topic: string, event: string): NotifyMessage[];
  settle(ms?: number): Promise<void>;
  close(): Promise<void>;
}> {
  const client = new pg.Client({ connectionString: url, application_name: 'farm-test-listen' });
  await client.connect();
  const messages: NotifyMessage[] = [];
  client.on('notification', (n) => {
    if (n.channel === 'app_events' && n.payload) messages.push(JSON.parse(n.payload));
  });
  await client.query('listen app_events');
  return {
    messages,
    of: (topic, event) => messages.filter((m) => m.topic === topic && m.event === event),
    settle: (ms = 150) => new Promise((r) => setTimeout(r, ms)),
    close: () => client.end(),
  };
}

/** Write the farm's machines, fields (+ current boundary), elevators and external refs. */
export async function seedSimFarm(db: Db, farm: SimFarm, eldVendor: EldVendor): Promise<void> {
  for (const p of farm.parties) {
    await db
      .insert(parties)
      .values({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        roles: p.roles,
        source: 'demo',
        sourceId: p.key,
      })
      .onConflictDoNothing();
  }
  for (const u of farm.farms) {
    await db
      .insert(farms)
      .values({
        id: u.id,
        name: u.name,
        clientPartyId: u.clientPartyId,
        deereFarmId: u.deereFarmId,
        source: 'demo',
        sourceId: u.key,
      })
      .onConflictDoNothing();
  }
  for (const f of farm.fields) {
    await db
      .insert(fields)
      .values({
        id: f.id,
        farmId: f.farmId,
        name: f.name,
        tenure: f.tenure,
        countyFips: f.countyFips,
        deereFieldId: f.deereFieldId,
        source: 'demo',
        sourceId: f.key,
      })
      .onConflictDoNothing();
    await db
      .insert(fieldBoundaries)
      .values({
        id: f.boundaryId,
        fieldId: f.id,
        geom: f.boundary,
        valid: { from: new Date('2020-01-01T00:00:00Z'), to: null },
        source: 'demo',
        sourceId: `boundary:${f.key}`,
      })
      .onConflictDoNothing();
  }
  for (const m of farm.machines) {
    await db
      .insert(machines)
      .values({
        id: m.id,
        kind: m.kind,
        unitNo: m.unitNo,
        make: m.make,
        model: m.model,
        year: m.year,
        source: 'demo',
        sourceId: m.key,
      })
      .onConflictDoNothing();
  }
  for (const e of farm.elevators) {
    await db
      .insert(geofences)
      .values({
        id: e.id,
        kind: 'elevator',
        name: e.name,
        partyId: e.partyId,
        geom: e.geofence,
        source: 'demo',
        sourceId: e.key,
      })
      .onConflictDoNothing();
  }
  for (const r of simExternalRefs(farm, eldVendor)) {
    await upsertExternalRef(db, r.ref, r.entityId);
  }
}
