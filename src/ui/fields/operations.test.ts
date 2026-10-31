import { describe, expect, test } from 'vitest';
import type { FieldOperationsResponse, OperationView } from '../../domain/operations';
import type { RealtimeClient, TopicMessage } from '../../platform/realtime/types';
import {
  acresText,
  dateRangeText,
  machinesText,
  measurementsText,
  OPERATIONS_REALTIME_HEADER,
  type OperationsState,
  operationRowText,
  productText,
  startFieldOperations,
  unitText,
} from './operations';

const FIELD = '0b0c8f7e-6a54-4c4e-9f43-4a6f0a3b9c11';

const harvest: OperationView = {
  id: 'op-1',
  kind: 'harvest',
  cropYear: 2026,
  crop: 'corn',
  startedAt: '2026-10-15T11:10:52.000Z',
  endedAt: '2026-10-16T00:34:28.000Z',
  areaReportedAc: 150.8,
  areaClippedAc: 148.2,
  products: [
    { name: 'NF 108-22', kind: 'seed', rate: null, rateUnit: null, total: null, totalUnit: null },
  ],
  measurements: { areaAc: 150.8, yieldBuAc: 182.7, totalBu: 27551.2, moisturePct: 18.4 },
  machines: [
    { id: 'm1', unitNo: 'C1' },
    { id: 'm2', unitNo: 'GC1' },
  ],
  operatorName: 'Dale Mercer',
  status: 'provisional',
  source: 'deere',
  hasCoverage: true,
};

describe('text', () => {
  test('ADAPT unit ids in words', () => {
    expect(unitText('seeds1ac-1')).toBe('seeds/ac');
    expect(unitText('gal1ac-1')).toBe('gal/ac');
    expect(unitText('floz1ac-1')).toBe('fl oz/ac');
    expect(unitText('lb1ac-1')).toBe('lb/ac');
    expect(unitText('t1ha-1')).toBe('t/ha');
    expect(unitText('prcnt')).toBe('%');
    expect(unitText('gal')).toBe('gal');
    expect(unitText(null)).toBe('');
  });

  test('products: rate, else total, else the name', () => {
    expect(
      productText({
        name: 'NF 108-22',
        kind: 'seed',
        rate: 34000,
        rateUnit: 'seeds1ac-1',
        total: 5e6,
        totalUnit: 'seeds',
      }),
    ).toBe('NF 108-22 · 34,000 seeds/ac');
    expect(
      productText({
        name: 'Water',
        kind: 'other',
        rate: null,
        rateUnit: null,
        total: 2262,
        totalUnit: 'gal',
      }),
    ).toBe('Water · 2,262 gal');
    expect(
      productText({
        name: 'AMS',
        kind: null,
        rate: null,
        rateUnit: null,
        total: null,
        totalUnit: null,
      }),
    ).toBe('AMS');
  });

  test('dates in Michigan: one day, a span in a month, a span across months, still running', () => {
    expect(dateRangeText('2026-05-06T13:12:00Z', '2026-05-06T19:47:00Z')).toBe('May 6');
    expect(dateRangeText(harvest.startedAt, harvest.endedAt)).toBe('Oct 15'); // 20:34 local
    expect(dateRangeText('2026-10-15T11:00:00Z', '2026-10-16T15:00:00Z')).toBe('Oct 15–16');
    expect(dateRangeText('2026-10-31T13:00:00Z', '2026-11-02T15:00:00Z')).toBe('Oct 31 – Nov 2');
    expect(dateRangeText('2026-10-31T13:00:00Z', null)).toBe('Oct 31 (still running)');
  });

  test('acres, measurements, machines', () => {
    expect(acresText(harvest)).toBe('150.8 ac (148.2 in the field)');
    expect(acresText({ areaReportedAc: 80, areaClippedAc: 80.04 })).toBe('80 ac');
    expect(acresText({ areaReportedAc: 80, areaClippedAc: null })).toBe('80 ac');
    expect(acresText({ areaReportedAc: 152.4, areaClippedAc: 152.6 })).toBe('152.4 ac');
    expect(acresText({ areaReportedAc: 2100, areaClippedAc: 152.6 })).toBe(
      '2,100 ac (152.6 in the field)',
    );
    expect(acresText({ areaReportedAc: null, areaClippedAc: 12.25 })).toBe('12.3 ac in the field');
    expect(acresText({ areaReportedAc: null, areaClippedAc: null })).toBe('acres not reported');
    expect(measurementsText(harvest)).toBe('182.7 bu/ac · 27,551 bu · 18.4% moisture');
    expect(measurementsText({ measurements: { avgSpeedMph: 5.5 } })).toBe('5.5 mph');
    expect(machinesText(harvest)).toBe('C1, GC1 · Dale Mercer');
    expect(machinesText({ machines: [], operatorName: null })).toBe('');
  });

  test('one row', () => {
    expect(operationRowText(harvest)).toEqual({
      title: 'Harvest · corn',
      dates: 'Oct 15',
      acres: '150.8 ac (148.2 in the field)',
      measurements: '182.7 bu/ac · 27,551 bu · 18.4% moisture',
      products: ['NF 108-22'],
      machines: 'C1, GC1 · Dale Mercer',
      coverage: 'coverage mapped',
      status: 'may still change',
      source: 'Ops Center',
    });
    expect(
      operationRowText({
        ...harvest,
        kind: 'seeding',
        crop: null,
        hasCoverage: false,
        status: 'final',
      }),
    ).toMatchObject({
      title: 'Planting',
      coverage: 'no coverage map',
      status: 'final',
    });
  });
});

// ---------------------------------------------------------------------------------------------

type Handler = (evt: TopicMessage<'fields'>) => void;

function fakeRealtime() {
  const subs: { onEvent: Handler; onResync: () => void }[] = [];
  const client: RealtimeClient = {
    subscribe: ((_topic: string, onEvent: Handler, opts: { onResync(): void }) => {
      const s = { onEvent, onResync: opts.onResync };
      subs.push(s);
      return () => subs.splice(subs.indexOf(s), 1);
    }) as RealtimeClient['subscribe'],
  };
  return { client, subs };
}

function body(operations: OperationView[] = [harvest]): FieldOperationsResponse {
  return { fieldId: FIELD, cropYear: 2026, operations };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const noTimers = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};

describe('startFieldOperations', () => {
  test('loads, subscribes from the headers, refetches on this field’s operations only', async () => {
    const rt = fakeRealtime();
    let answer = body();
    const urls: string[] = [];
    const headersSeen: (string | null)[] = [];
    const states: OperationsState[] = [];
    const loader = startFieldOperations({
      fieldId: FIELD,
      fetch: (async (input: string) => {
        urls.push(String(input));
        return new Response(JSON.stringify(answer), {
          headers: { [OPERATIONS_REALTIME_HEADER]: 'sse', 'x-farm-app-env': 'test' },
        });
      }) as typeof fetch,
      realtime: (h) => {
        headersSeen.push(h.realtime, h.appEnv);
        return { client: rt.client, connected: () => true };
      },
      onState: (s) => states.push(s),
      debounceMs: 0,
      timers: noTimers,
    });
    await flush();
    expect(urls).toEqual([`/api/fields/${FIELD}/operations`]);
    expect(headersSeen).toEqual(['sse', 'test']);
    expect(states.at(-1)).toMatchObject({ status: 'ready', data: body() });
    expect(rt.subs).toHaveLength(1);

    const sub = rt.subs[0];
    sub?.onEvent({
      event: 'updated',
      payload: { fieldId: 'other', parts: ['operations'] },
      seq: 1,
    });
    sub?.onEvent({ event: 'updated', payload: { fieldId: FIELD, parts: ['notes'] }, seq: 2 });
    await flush();
    expect(urls).toHaveLength(1);

    answer = body([harvest, { ...harvest, id: 'op-2', kind: 'tillage' }]);
    sub?.onEvent({ event: 'updated', payload: { fieldId: FIELD, parts: ['operations'] }, seq: 3 });
    await flush();
    expect(urls).toHaveLength(2);
    expect(states.at(-1)?.data?.operations).toHaveLength(2);

    // An identical answer (a resync) renders nothing new.
    const before = states.length;
    sub?.onResync();
    await flush();
    expect(urls).toHaveLength(3);
    expect(states.length).toBe(before);

    loader.stop();
    expect(rt.subs).toHaveLength(0);
  });

  test('404, 403 and a failed refetch keep what they should', async () => {
    const statuses = [404, 403];
    for (const status of statuses) {
      const states: OperationsState[] = [];
      const l = startFieldOperations({
        fieldId: FIELD,
        fetch: (async () => new Response('{}', { status })) as unknown as typeof fetch,
        realtime: () => null,
        onState: (s) => states.push(s),
        timers: noTimers,
      });
      await flush();
      expect(states.at(-1)?.status).toBe(status === 404 ? 'not_found' : 'denied');
      l.stop();
    }
    let fail = false;
    const states: OperationsState[] = [];
    const l = startFieldOperations({
      fieldId: FIELD,
      fetch: (async () => {
        if (fail) throw new TypeError('offline');
        return new Response(JSON.stringify(body()));
      }) as typeof fetch,
      realtime: () => null,
      onState: (s) => states.push(s),
      debounceMs: 0,
      timers: noTimers,
    });
    await flush();
    fail = true;
    l.refetch();
    await flush();
    expect(states.at(-1)).toMatchObject({ status: 'ready', error: 'no connection', data: body() });
    l.stop();
  });

  test("an answer for another field is refused; polls only while realtime can't deliver", async () => {
    const ticks: (() => void)[] = [];
    const states: OperationsState[] = [];
    let calls = 0;
    const l = startFieldOperations({
      fieldId: FIELD,
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ ...body(), fieldId: 'someone-else' }));
      }) as typeof fetch,
      realtime: () => null,
      onState: (s) => states.push(s),
      timers: { ...noTimers, setInterval: (fn: () => void) => ticks.push(fn) },
    });
    await flush();
    expect(states.at(-1)).toMatchObject({ status: 'error', error: 'unexpected response' });
    ticks[0]?.();
    await flush();
    expect(calls).toBe(2);
    l.stop();
  });
});
