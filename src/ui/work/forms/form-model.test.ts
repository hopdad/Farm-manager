/**
 * The job form's rules (docs/contracts-2a.md §7.3): defaults of a new job, the knock-on changes
 * (lane follows kind, a field brings its customer), every check, the POST body, the PATCH body
 * (only what changed, with the version), and the rebase after a 409.
 */
import { describe, expect, test } from 'vitest';
import { createJobBodySchema, updateJobBodySchema } from '../contract';
import { FIXTURE_IDS, makeJobOptions, makeJobView } from './fixtures';
import {
  applyChange,
  changesSomething,
  createBody,
  defaultRateUnit,
  type FormKey,
  type JobFormValues,
  jobValues,
  kindForLane,
  newJobValues,
  parseNumber,
  rebase,
  toPriority,
  updateBody,
  validate,
} from './form-model';

const options = makeJobOptions();
const change = <K extends FormKey>(
  s: { values: JobFormValues; dirty: ReadonlySet<FormKey> },
  key: K,
  value: JobFormValues[K],
  mode: 'new' | 'edit' = 'new',
) => applyChange(s, key, value, { mode, options });
const fresh = (values: JobFormValues) => ({ values, dirty: new Set<FormKey>() });

describe('a new job', () => {
  test('defaults: a spray job in the spraying lane, normal priority, planned', () => {
    const v = newJobValues();
    expect(v).toMatchObject({
      kind: 'spray',
      businessLine: 'spraying',
      status: 'planned',
      priority: 3,
      fieldId: '',
      customerPartyId: '',
      products: [],
    });
  });

  test("a lane's New job starts with that lane's kind", () => {
    expect(kindForLane('spraying')).toBe('spray');
    expect(kindForLane('grain')).toBe('plant');
    expect(kindForLane('trucking')).toBe('haul');
    expect(kindForLane('store')).toBe('other');
    expect(newJobValues({ businessLine: 'trucking' })).toMatchObject({
      kind: 'haul',
      businessLine: 'trucking',
    });
    expect(newJobValues({ businessLine: 'store' })).toMatchObject({
      kind: 'other',
      businessLine: 'store',
    });
    expect(newJobValues({ kind: 'harvest' }).businessLine).toBe('grain');
  });

  test("a tapped field brings its farm's customer", () => {
    expect(newJobValues({ fieldId: FIXTURE_IDS.field }, options).customerPartyId).toBe(
      FIXTURE_IDS.customer,
    );
    expect(newJobValues({ fieldId: FIXTURE_IDS.otherField }, options).customerPartyId).toBe('');
    expect(newJobValues({ fieldId: FIXTURE_IDS.field }, null).customerPartyId).toBe('');
  });
});

describe('knock-on changes', () => {
  test("a new job's lane follows its kind until the lane is picked", () => {
    let s = change(fresh(newJobValues()), 'kind', 'haul');
    expect(s.values.businessLine).toBe('trucking');
    s = change(s, 'businessLine', 'store');
    s = change(s, 'kind', 'spray');
    expect(s.values.businessLine).toBe('store');
    // An edit never moves the lane by itself.
    const e = change(fresh(jobValues(makeJobView())), 'kind', 'haul', 'edit');
    expect(e.values.businessLine).toBe('spraying');
  });

  test('a field fills an empty, untouched customer', () => {
    const s = change(fresh(newJobValues()), 'fieldId', FIXTURE_IDS.field);
    expect(s.values.customerPartyId).toBe(FIXTURE_IDS.customer);
    expect(s.dirty.has('customerPartyId')).toBe(true);
    let t = change(fresh(newJobValues()), 'customerPartyId', '');
    t = change(t, 'fieldId', FIXTURE_IDS.field);
    expect(t.values.customerPartyId).toBe('');
    let u = change(fresh(newJobValues()), 'customerPartyId', FIXTURE_IDS.person);
    u = change(u, 'fieldId', FIXTURE_IDS.field);
    expect(u.values.customerPartyId).toBe(FIXTURE_IDS.person);
  });

  test('going back to planned drops the request channel', () => {
    let s = change(fresh(newJobValues()), 'status', 'requested');
    s = change(s, 'requestChannel', 'phone');
    s = change(s, 'status', 'planned');
    expect(s.values.requestChannel).toBe('');
  });
});

describe('checks', () => {
  const base = newJobValues();
  test('a clean new job passes', () => {
    expect(validate(base, 'new')).toEqual({});
  });

  test('the window must end after it starts, and be real times', () => {
    expect(
      validate({ ...base, windowFrom: '2026-11-09T08:00', windowTo: '2026-11-09T08:00' }, 'new'),
    ).toHaveProperty('windowTo');
    expect(validate({ ...base, windowFrom: 'soon' }, 'new')).toHaveProperty('windowFrom');
    expect(
      validate({ ...base, windowFrom: '2026-11-09T08:00', windowTo: '2026-11-10T17:00' }, 'new'),
    ).toEqual({});
    expect(validate({ ...base, windowTo: '2026-11-10T17:00' }, 'new')).toEqual({});
  });

  test('acres, amounts and their unit', () => {
    expect(validate({ ...base, plannedAcres: '-3' }, 'new')).toHaveProperty('plannedAcres');
    expect(validate({ ...base, plannedAcres: 'lots' }, 'new')).toHaveProperty('plannedAcres');
    expect(validate({ ...base, plannedAcres: '1,234.5' }, 'new')).toEqual({});
    expect(validate({ ...base, plannedQty: '12' }, 'new')).toHaveProperty('plannedUnit');
    expect(validate({ ...base, plannedQty: '12', plannedUnit: 'loads' }, 'new')).toEqual({});
  });

  test('text limits', () => {
    expect(validate({ ...base, title: 'x'.repeat(81) }, 'new')).toHaveProperty('title');
    expect(validate({ ...base, notes: 'x'.repeat(4001) }, 'new')).toHaveProperty('notes');
    expect(
      validate(
        { ...base, status: 'requested', requestChannel: 'text', requesterPhone: '5'.repeat(41) },
        'new',
      ),
    ).toHaveProperty('requesterPhone');
  });

  test('a requested job says how they asked', () => {
    expect(validate({ ...base, status: 'requested' }, 'new')).toHaveProperty('requestChannel');
    expect(validate({ ...base, status: 'requested', requestChannel: 'phone' }, 'new')).toEqual({});
  });

  test('products: one each, a rate needs its unit, at most 20', () => {
    const line = (key: string, productId: string, rate = '', unit: 'gal_ac' | '' = 'gal_ac') => ({
      key,
      productId,
      rate,
      unit,
      suppliedBy: 'us' as const,
    });
    expect(validate({ ...base, products: [line('a', '')] }, 'new')).toHaveProperty('product:a');
    expect(
      validate({ ...base, products: [line('a', 'p1'), line('b', 'p1')] }, 'new'),
    ).toHaveProperty('product:b');
    expect(validate({ ...base, products: [line('a', 'p1', '2', '')] }, 'new')).toHaveProperty(
      'product:a',
    );
    expect(validate({ ...base, products: [line('a', 'p1', '-1')] }, 'new')).toHaveProperty(
      'product:a',
    );
    const many = Array.from({ length: 21 }, (_, i) => line(`k${i}`, `p${i}`));
    expect(validate({ ...base, products: many }, 'new')).toHaveProperty('products');
    expect(validate({ ...base, products: [line('a', 'p1', '1.5')] }, 'new')).toEqual({});
  });
});

describe('POST body', () => {
  test('a minimal job sends its kind, lane, status and priority', () => {
    const body = createBody(newJobValues());
    expect(body).toEqual({
      kind: 'spray',
      businessLine: 'spraying',
      status: 'planned',
      priority: 3,
    });
    expect(createJobBodySchema.safeParse(body).success).toBe(true);
  });

  test('every field of a requested job phoned in', () => {
    const v: JobFormValues = {
      ...newJobValues({ fieldId: FIXTURE_IDS.field }, options),
      status: 'requested',
      title: '  Burndown before wheat  ',
      windowFrom: '2026-11-09T08:00',
      windowTo: '2026-11-10T17:00',
      cropYear: '2027',
      plannedAcres: '80',
      plannedQty: '2',
      plannedUnit: 'loads',
      priority: 2,
      notes: 'Gate code 1234',
      requestChannel: 'phone',
      requestPartyId: FIXTURE_IDS.person,
      requesterName: 'Gail Pressler',
      requesterPhone: '(517) 555-0100',
      products: [
        {
          key: 'a',
          productId: FIXTURE_IDS.glyphosate,
          rate: '32',
          unit: 'floz_ac',
          suppliedBy: 'us',
        },
        { key: 'b', productId: FIXTURE_IDS.uan, rate: '', unit: '', suppliedBy: 'customer' },
      ],
    };
    const body = createBody(v);
    expect(body).toEqual({
      kind: 'spray',
      businessLine: 'spraying',
      status: 'requested',
      title: 'Burndown before wheat',
      fieldId: FIXTURE_IDS.field,
      customerPartyId: FIXTURE_IDS.customer,
      window: { from: '2026-11-09T08:00:00-05:00', to: '2026-11-10T17:00:00-05:00' },
      cropYear: 2027,
      plannedAcres: 80,
      plannedQty: 2,
      plannedUnit: 'loads',
      priority: 2,
      notes: 'Gate code 1234',
      request: {
        channel: 'phone',
        partyId: FIXTURE_IDS.person,
        name: 'Gail Pressler',
        phone: '(517) 555-0100',
      },
      products: [
        { productId: FIXTURE_IDS.glyphosate, rate: 32, unit: 'floz_ac', suppliedBy: 'us' },
        { productId: FIXTURE_IDS.uan, rate: null, unit: null, suppliedBy: 'customer' },
      ],
    });
    expect(createJobBodySchema.safeParse(body).success).toBe(true);
  });

  test('a planned job carries no request even if the inputs still hold one', () => {
    const body = createBody({ ...newJobValues(), requestChannel: 'text', requesterName: 'X' });
    expect(body).not.toHaveProperty('request');
  });
});

describe('PATCH body', () => {
  const job = makeJobView({ version: 7 });

  test('nothing changed: only the version', () => {
    const body = updateBody(jobValues(job), job, new Set());
    expect(body).toEqual({ version: 7 });
    expect(changesSomething(body)).toBe(false);
  });

  test('only changed inputs, and only when they differ from the job', () => {
    const v = { ...jobValues(job), title: 'Burndown', notes: '' };
    const body = updateBody(v, job, new Set<FormKey>(['title', 'notes', 'kind']));
    expect(body).toEqual({ version: 7, title: 'Burndown' });
    expect(updateJobBodySchema.safeParse(body).success).toBe(true);
    // A changed value that wasn't touched (it came from an older copy) is not sent.
    expect(updateBody({ ...v, priority: 1 }, job, new Set<FormKey>(['title']))).toEqual({
      version: 7,
      title: 'Burndown',
    });
  });

  test('clearing fields sends null', () => {
    const v = { ...jobValues(job), fieldId: '', customerPartyId: '', windowFrom: '', windowTo: '' };
    const body = updateBody(
      v,
      job,
      new Set<FormKey>(['fieldId', 'customerPartyId', 'windowFrom', 'windowTo']),
    );
    expect(body).toEqual({ version: 7, fieldId: null, customerPartyId: null, window: null });
    expect(updateJobBodySchema.safeParse(body).success).toBe(true);
  });

  test('planned acres: typed by hand, back to the boundary', () => {
    const typed = updateBody(
      { ...jobValues(job), plannedAcres: '75' },
      job,
      new Set(['plannedAcres']),
    );
    expect(typed).toEqual({ version: 7, plannedAcres: 75 });
    const byHand = makeJobView({ version: 7, plannedAcres: 75, plannedAcresByHand: true });
    expect(jobValues(byHand).plannedAcres).toBe('75');
    expect(jobValues(job).plannedAcres).toBe('');
    const back = updateBody(
      { ...jobValues(byHand), plannedAcres: '' },
      byHand,
      new Set(['plannedAcres']),
    );
    expect(back).toEqual({ version: 7, plannedAcres: null });
    // Emptying acres that follow the boundary already sends nothing.
    expect(updateBody(jobValues(job), job, new Set(['plannedAcres']))).toEqual({ version: 7 });
  });

  test('window, crop year and products', () => {
    const v = {
      ...jobValues(job),
      windowTo: '2026-11-10T17:00',
      cropYear: '2027',
      products: [
        ...jobValues(job).products,
        {
          key: 'n',
          productId: FIXTURE_IDS.uan,
          rate: '10',
          unit: 'gal_ac' as const,
          suppliedBy: 'customer' as const,
        },
      ],
    };
    const body = updateBody(v, job, new Set<FormKey>(['windowTo', 'cropYear', 'products']));
    expect(body).toEqual({
      version: 7,
      window: { from: '2026-11-09T08:00:00-05:00', to: '2026-11-10T17:00:00-05:00' },
      cropYear: 2027,
      products: [
        { productId: FIXTURE_IDS.glyphosate, rate: 32, unit: 'floz_ac', suppliedBy: 'us' },
        { productId: FIXTURE_IDS.uan, rate: 10, unit: 'gal_ac', suppliedBy: 'customer' },
      ],
    });
    expect(updateJobBodySchema.safeParse(body).success).toBe(true);
    // The same window and products as the job: nothing to send.
    expect(updateBody(jobValues(job), job, new Set<FormKey>(['windowFrom', 'products']))).toEqual({
      version: 7,
    });
  });

  test('request details: set, changed, cleared', () => {
    const asked = makeJobView({
      version: 7,
      status: 'requested',
      request: { channel: 'text', partyId: null, name: 'Gail', phone: null, viaLink: false },
    });
    const v = jobValues(asked);
    expect(v.requestChannel).toBe('text');
    expect(
      updateBody({ ...v, requesterPhone: '555-0100' }, asked, new Set(['requesterPhone'])),
    ).toEqual({
      version: 7,
      request: { channel: 'text', partyId: null, name: 'Gail', phone: '555-0100' },
    });
    expect(updateBody({ ...v, requestChannel: '' }, asked, new Set(['requestChannel']))).toEqual({
      version: 7,
      request: null,
    });
    expect(updateBody(v, asked, new Set(['requesterName']))).toEqual({ version: 7 });
  });
});

describe('after a 409', () => {
  test("the person's changes stay on top of the current job", () => {
    const old = makeJobView({ version: 3, title: null, notes: 'old notes', priority: 3 });
    const current = makeJobView({
      version: 4,
      title: 'Renamed elsewhere',
      notes: 'old notes',
      priority: 1,
    });
    const mine = { ...jobValues(old), notes: 'my notes' };
    const dirty = new Set<FormKey>(['notes']);
    const merged = rebase(mine, dirty, current);
    expect(merged.notes).toBe('my notes');
    expect(merged.title).toBe('Renamed elsewhere');
    expect(merged.priority).toBe(1);
    expect(updateBody(merged, current, dirty)).toEqual({ version: 4, notes: 'my notes' });
  });
});

describe('helpers', () => {
  test('numbers as people type them', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(' 1,234.5 ')).toBe(1234.5);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('3.')).toBe(3);
    expect(parseNumber('-1')).toBeNaN();
    expect(parseNumber('1e3')).toBeNaN();
  });

  test('a product brings its rate unit; priorities from the wire', () => {
    expect(defaultRateUnit('gal')).toBe('gal_ac');
    expect(defaultRateUnit('floz')).toBe('floz_ac');
    expect(defaultRateUnit('bag')).toBe('unit_ac');
    expect(defaultRateUnit('kseed')).toBe('kseed_ac');
    expect(toPriority(1)).toBe(1);
    expect(toPriority(9)).toBe(3);
  });
});
