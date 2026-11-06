/**
 * app.usage_events (decision 2a-11; docs/contracts-2a.md §3.1, §7.6, §7.7; owner: rights-usage):
 * the writer's insert, the /admin/usage report's reads and the usage.prune retention delete.
 *
 *  - `insertUsageEvent`: one row, `on conflict (actor_key, kind, route, bucket_at) do nothing`
 *    (the 5-minute bucket key), so a page reloaded ten times in a bucket is one row. The person
 *    and device ids are written only while their rows exist (a person deleted between the
 *    session check and the insert writes null, never a foreign-key error); `actor_key` keeps
 *    them either way.
 *  - The report reads three small aggregates over a range of farm days (the `farm_day` index):
 *    who was active each day (with the role and the demo/test marks the gate needs), board time
 *    per device (distinct heartbeat buckets per device, by `actor_key`'s device part so a
 *    deleted device still counts), and the day's counts per kind. src/platform/usage/report.ts
 *    turns them into the page (pure).
 *  - `pruneUsageEvents`: rows of farm days before the cutoff, in batches, until the deadline.
 */
import { USAGE_KINDS, type UsageKind } from '../../domain/work-jobs';
import { type Executor, exec } from '../exec';

export interface UsageEventRow {
  at: Date;
  farmDay: string;
  kind: UsageKind;
  route: string;
  appUserId: string | null;
  deviceId: string | null;
  actorKey: string;
  bucketAt: Date;
}

/** Insert one usage event. True when written, false when its bucket already had it. */
export async function insertUsageEvent(ex: Executor, row: UsageEventRow): Promise<boolean> {
  const r = await exec(
    ex,
    `insert into app.usage_events
       (at, farm_day, kind, route, app_user_id, device_id, actor_key, bucket_at)
     values ($1::timestamptz, $2::date, $3, $4,
             (select id from farm.app_users where id = $5::uuid),
             (select id from farm.devices where id = $6::uuid),
             $7, $8::timestamptz)
     on conflict (actor_key, kind, route, bucket_at) do nothing`,
    [
      row.at.toISOString(),
      row.farmDay,
      row.kind,
      row.route,
      row.appUserId,
      row.deviceId,
      row.actorKey,
      row.bucketAt.toISOString(),
    ],
  );
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------------------------
// The report's reads
// ---------------------------------------------------------------------------------------------

/** One person active on one farm day (any usage event with their app user). */
export interface UsagePersonDay {
  farmDay: string;
  appUserId: string;
  name: string;
  /** The app role now (farm.app_users.role). */
  role: string;
  /** Source of the app user or the party is demo, sim or e2e: never counted for the gate. */
  demoOrTest: boolean;
}

/** One device's board time on one farm day. */
export interface UsageDeviceDay {
  farmDay: string;
  /** `actor_key`'s device part ('-' = no enrolled device: a person on their own browser). */
  deviceKey: string;
  /** The device's name now; null when deleted or not a device. */
  deviceName: string | null;
  /** For deviceKey '-': the person's name (their own browser). */
  personName: string | null;
  /** Distinct 5-minute buckets with at least one heartbeat. */
  buckets: number;
}

/** Events of one kind on one farm day. */
export interface UsageKindDay {
  farmDay: string;
  kind: UsageKind;
  events: number;
}

export interface UsageReportRows {
  people: UsagePersonDay[];
  boardTime: UsageDeviceDay[];
  counts: UsageKindDay[];
}

/** The report's raw rows for farm days `fromDay` … `toDay` (inclusive, 'YYYY-MM-DD'). */
export async function loadUsageReportRows(
  ex: Executor,
  fromDay: string,
  toDay: string,
): Promise<UsageReportRows> {
  const [people, boardTime, counts] = await Promise.all([
    exec<{
      farm_day: string;
      app_user_id: string;
      name: string;
      role: string;
      demo_or_test: boolean;
    }>(
      ex,
      `select e.farm_day::text as farm_day, u.id::text as app_user_id, p.display_name as name,
              u.role, (u.source in ('demo', 'sim', 'e2e') or p.source in ('demo', 'sim', 'e2e'))
                as demo_or_test
         from app.usage_events e
         join farm.app_users u on u.id = e.app_user_id
         join farm.parties p on p.id = u.party_id
        where e.farm_day between $1::date and $2::date
        group by e.farm_day, u.id, p.display_name, u.role, u.source, p.source
        order by e.farm_day, lower(p.display_name), u.id`,
      [fromDay, toDay],
    ),
    exec<{
      farm_day: string;
      device_key: string;
      device_name: string | null;
      person_name: string | null;
      buckets: number;
    }>(
      ex,
      `select b.farm_day::text as farm_day, b.device_key, d.name as device_name,
              case when b.device_key = '-' then p.display_name end as person_name,
              count(distinct b.bucket_at)::int as buckets
         from (
           select e.farm_day, e.bucket_at, split_part(e.actor_key, ':', 1) as device_key,
                  split_part(e.actor_key, ':', 2) as person_key
             from app.usage_events e
            where e.kind = 'board_heartbeat' and e.farm_day between $1::date and $2::date
         ) b
         left join farm.devices d on b.device_key <> '-' and d.id::text = b.device_key
         left join farm.app_users u on b.device_key = '-' and b.person_key <> '-'
                                   and u.id::text = b.person_key
         left join farm.parties p on p.id = u.party_id
        group by b.farm_day, b.device_key, d.name,
                 case when b.device_key = '-' then b.person_key end,
                 case when b.device_key = '-' then p.display_name end
        order by b.farm_day, count(distinct b.bucket_at) desc, b.device_key`,
      [fromDay, toDay],
    ),
    exec<{ farm_day: string; kind: UsageKind; events: number }>(
      ex,
      `select farm_day::text as farm_day, kind, count(*)::int as events
         from app.usage_events
        where farm_day between $1::date and $2::date
        group by farm_day, kind
        order by farm_day, kind`,
      [fromDay, toDay],
    ),
  ]);
  return {
    people: people.rows.map((r) => ({
      farmDay: r.farm_day,
      appUserId: r.app_user_id,
      name: r.name,
      role: r.role,
      demoOrTest: r.demo_or_test,
    })),
    boardTime: boardTime.rows.map((r) => ({
      farmDay: r.farm_day,
      deviceKey: r.device_key,
      deviceName: r.device_name,
      personName: r.person_name,
      buckets: r.buckets,
    })),
    counts: counts.rows
      .filter((r) => (USAGE_KINDS as readonly string[]).includes(r.kind))
      .map((r) => ({ farmDay: r.farm_day, kind: r.kind, events: r.events })),
  };
}

// ---------------------------------------------------------------------------------------------
// Retention (usage.prune)
// ---------------------------------------------------------------------------------------------

/** Rows deleted per statement (small enough to never hold a long lock). */
export const USAGE_PRUNE_BATCH = 5_000;

export interface UsagePruneResult {
  deleted: number;
  /** False when the deadline stopped it with rows left (the next run goes on). */
  complete: boolean;
  batches: number;
}

/**
 * Delete the events of farm days before `beforeDay` ('YYYY-MM-DD'), `batch` rows a statement,
 * until none are left, the deadline passes or `signal` aborts (the job runner's: the deadline
 * or a shutdown).
 */
export async function pruneUsageEvents(
  ex: Executor,
  beforeDay: string,
  deadline: Date,
  opts: { batch?: number; clock?: () => number; signal?: AbortSignal } = {},
): Promise<UsagePruneResult> {
  const batch = opts.batch ?? USAGE_PRUNE_BATCH;
  const clock = opts.clock ?? Date.now;
  const out: UsagePruneResult = { deleted: 0, complete: true, batches: 0 };
  for (;;) {
    if (clock() >= deadline.getTime() || opts.signal?.aborted) {
      out.complete = false;
      return out;
    }
    const r = await exec(
      ex,
      `delete from app.usage_events where id = any(array(
         select id from app.usage_events where farm_day < $1::date limit $2))`,
      [beforeDay, batch],
    );
    out.batches++;
    out.deleted += r.rowCount;
    if (r.rowCount < batch) return out;
  }
}
