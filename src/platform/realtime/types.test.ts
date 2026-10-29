/**
 * Type-level contract of the realtime client: narrowing on `evt.event` narrows `evt.payload`.
 * `pnpm typecheck` enforces the expectTypeOf lines (they are no-ops at runtime). Deliberately
 * independent of client.ts, which the runtime agent replaces.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { FleetTick } from '../../domain/fleet';
import type {
  ClockPayload,
  InvalidatePayload,
  RealtimeClient,
  SyncStatusPayload,
  TopicMessage,
} from './types';

describe('TopicMessage', () => {
  test('is a union discriminated on event', () => {
    const onFleet = (evt: TopicMessage<'fleet'>) => {
      expectTypeOf(evt.seq).toEqualTypeOf<number>();
      if (evt.event === 'tick') {
        expectTypeOf(evt.payload).toEqualTypeOf<FleetTick>();
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
        } else {
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
