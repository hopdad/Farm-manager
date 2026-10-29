/**
 * Type-level contract of the realtime client: narrowing on `evt.event` narrows `evt.payload`.
 * `pnpm typecheck` enforces the expectTypeOf lines (they are no-ops at runtime). Deliberately
 * independent of client.ts, which the runtime agent replaces.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { FleetTick } from '../../domain/fleet';
import {
  type ClockPayload,
  type FieldUpdatedPayload,
  type InvalidatePayload,
  type LayerUpdatedPayload,
  type MachineStatusPayload,
  type RealtimeClient,
  type SprayAssessedPayload,
  type SyncStatusPayload,
  TOPICS,
  type Topic,
  type TopicMessage,
  type WeatherUpdatedPayload,
} from './types';

describe('TopicMessage', () => {
  test('is a union discriminated on event', () => {
    const onFleet = (evt: TopicMessage<'fleet'>) => {
      expectTypeOf(evt.seq).toEqualTypeOf<number>();
      if (evt.event === 'tick') {
        expectTypeOf(evt.payload).toEqualTypeOf<FleetTick>();
      } else if (evt.event === 'machine') {
        expectTypeOf(evt.payload).toEqualTypeOf<MachineStatusPayload>();
      } else {
        expectTypeOf(evt.event).toEqualTypeOf<'invalidate'>();
        expectTypeOf(evt.payload).toEqualTypeOf<InvalidatePayload>();
      }
    };
    const onAdmin = (evt: TopicMessage<'admin'>) => {
      switch (evt.event) {
        case 'clock':
          expectTypeOf(evt.payload).toEqualTypeOf<ClockPayload>();
          break;
        case 'sync.status':
          expectTypeOf(evt.payload).toEqualTypeOf<SyncStatusPayload>();
          break;
        default:
          expectTypeOf(evt.event).toEqualTypeOf<'invalidate'>();
          expectTypeOf(evt.payload).toEqualTypeOf<InvalidatePayload>();
      }
    };
    expectTypeOf(onFleet).toBeFunction();
    expectTypeOf(onAdmin).toBeFunction();
  });

  test('subscribe() types its callback from the topic', () => {
    const seen: string[] = [];
    // A stand-in implementation: delivers one message per event so both branches run.
    const client: RealtimeClient = {
      subscribe(topic, onEvent, opts) {
        const deliver = onEvent as (evt: { event: string; payload: unknown; seq: number }) => void;
        if (topic === 'fleet') {
          deliver({ event: 'tick', payload: { ts: 'x', machines: [] }, seq: 1 });
          deliver({ event: 'invalidate', payload: { reason: 'changed' }, seq: 2 });
        }
        opts.onResync();
        return () => {};
      },
    };
    let resyncs = 0;
    const unsubscribe = client.subscribe(
      'fleet',
      (evt) => {
        if (evt.event === 'tick') {
          expectTypeOf(evt.payload).toEqualTypeOf<FleetTick>();
          seen.push(`tick:${evt.payload.machines.length}`);
        } else if (evt.event === 'invalidate') {
          expectTypeOf(evt.payload).toEqualTypeOf<InvalidatePayload>();
          seen.push(`invalidate:${evt.payload.reason}`);
        }
      },
      { onResync: () => resyncs++ },
    );
    unsubscribe();
    expect(seen).toEqual(['tick:0', 'invalidate:changed']);
    expect(resyncs).toBe(1);
  });
});

describe('M1 topics', () => {
  test('TOPICS lists every topic of TopicEvents', () => {
    expectTypeOf<Exclude<Topic, (typeof TOPICS)[number]>>().toEqualTypeOf<never>();
    expect([...TOPICS].sort()).toEqual(['admin', 'fields', 'fleet', 'layers', 'spray', 'weather']);
  });

  test('each M1 event narrows to its payload', () => {
    const onFields = (evt: TopicMessage<'fields'>) => {
      if (evt.event === 'updated') expectTypeOf(evt.payload).toEqualTypeOf<FieldUpdatedPayload>();
      else expectTypeOf(evt.payload).toEqualTypeOf<InvalidatePayload>();
    };
    const onWeather = (evt: TopicMessage<'weather'>) => {
      if (evt.event === 'updated') expectTypeOf(evt.payload).toEqualTypeOf<WeatherUpdatedPayload>();
    };
    const onSpray = (evt: TopicMessage<'spray'>) => {
      if (evt.event === 'assessed') expectTypeOf(evt.payload).toEqualTypeOf<SprayAssessedPayload>();
    };
    const onLayers = (evt: TopicMessage<'layers'>) => {
      if (evt.event === 'updated') expectTypeOf(evt.payload).toEqualTypeOf<LayerUpdatedPayload>();
    };
    for (const f of [onFields, onWeather, onSpray, onLayers]) expectTypeOf(f).toBeFunction();
  });

  test("topic names pass the SSE route's topic check", async () => {
    const { parseTopics } = await import('./sse');
    expect(parseTopics(TOPICS.join(','))).toEqual({ ok: true, topics: [...TOPICS].sort() });
  });
});
