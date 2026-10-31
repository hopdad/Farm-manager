/** The recording scrubber (decision 3): no original id or name survives; shapes are kept. */
import { describe, expect, test } from 'vitest';
import { createScrubber, DEMO_AREA_CENTER } from './scrub';

const org = {
  '@type': 'Organization',
  id: '4475',
  name: 'Smith Family Farms',
  member: true,
  links: [
    { rel: 'self', uri: 'https://sandboxapi.deere.com/platform/organizations/4475' },
    {
      rel: 'connections',
      uri: 'https://connections.deere.com/connections/abc/select-organizations?orgId=4475',
    },
  ],
};
const machine = {
  id: 'f2b6e4c8-0000-4000-8000-000000000001',
  principalId: 8348986,
  name: '8R 410 (Dad)',
  serialNumber: '1RW8410RKPD012345',
  isgType: { id: 'isg-1', name: 'Tractor' },
  make: { id: 'mk', name: 'John Deere' },
  modelYear: '2023',
};
const crumb = { point: { lat: 44.5, lon: -93.1 }, eventTimestamp: '2026-10-31T12:00:00Z' };
const geo = {
  type: 'Polygon',
  coordinates: [
    [
      [-93.2, 44.4],
      [-93.0, 44.4],
      [-93.0, 44.6],
      [-93.2, 44.4],
    ],
  ],
};

function scrubbed() {
  const s = createScrubber({ salt: 'test' });
  const bodies = [
    { values: [org] },
    { values: [machine] },
    { values: [crumb] },
    geo,
    {
      data: [{ id: '212014918732717', name: 'Truck 7' }],
      pagination: { endCursor: 'b2Zmc2V0OjEwMA==', hasNextPage: true },
      access_token: 'eyJhbGciOi',
    },
  ];
  for (const b of bodies) s.observe(b);
  s.observeUrl(
    new URL('https://sandboxapi.deere.com/platform/machines/8348986/breadcrumbs?startDate=x'),
  );
  return { s, out: bodies.map((b) => s.scrub(b)) as Record<string, unknown>[] };
}

/** The first item of a scrubbed `{ values: [...] }` body. */
const firstOf = (b: Record<string, unknown> | undefined) =>
  ((b?.values ?? []) as Record<string, unknown>[])[0];

describe('createScrubber', () => {
  test('ids hashed by type and stable; names pseudonymized; catalog names kept', () => {
    const { s, out } = scrubbed();
    const o = firstOf(out[0]) as typeof org;
    expect(o.id).toMatch(/^\d{4}$/);
    expect(o.id).not.toBe('4475');
    expect(o.name).not.toBe(org.name);
    expect(o.name).toMatch(/^Name [0-9a-f]{6}$/);
    expect(o.member).toBe(true);
    expect(o.links[0]?.uri).toBe(`https://sandboxapi.deere.com/platform/organizations/${o.id}`);
    expect(new URL(o.links[1]?.uri as string).searchParams.get('orgId')).toBe(o.id);
    const m = firstOf(out[1]) as typeof machine;
    expect(typeof m.principalId).toBe('number');
    expect(m.principalId).not.toBe(8348986);
    expect(String(m.principalId)).toHaveLength(7);
    expect(m.id).toMatch(/^h[0-9a-f]+$/);
    expect(m.serialNumber).not.toBe(machine.serialNumber);
    expect(m.isgType.name).toBe('Tractor');
    expect(m.make.name).toBe('John Deere');
    expect(m.modelYear).toBe('2023');
    // The same id in a path: the same hash.
    expect(s.scrubPath('/machines/8348986/breadcrumbs')).toBe(
      `/machines/${m.principalId}/breadcrumbs`,
    );
    expect(
      s.scrubQuery(new URLSearchParams('organizationIds=4475&pageOffset=100&categories=Machine')),
    ).toEqual({
      organizationIds: o.id,
      pageOffset: '100',
      categories: 'Machine',
    });
  });

  test('coordinates move into the demo area as one translation; secrets and cursors replaced', () => {
    const { s, out } = scrubbed();
    const { dLng, dLat } = s.offset();
    const p = (firstOf(out[2]) as typeof crumb).point;
    expect(p.lat).toBeCloseTo(44.5 + dLat, 6);
    expect(p.lon).toBeCloseTo(-93.1 + dLng, 6);
    expect(Math.abs(p.lat - DEMO_AREA_CENTER.lat)).toBeLessThan(1);
    const ring = (out[3] as typeof geo).coordinates[0] as number[][];
    expect(ring[0]?.[0]).toBeCloseTo(-93.2 + dLng, 6);
    expect((ring[2]?.[1] ?? 0) - (ring[0]?.[1] ?? 0)).toBeCloseTo(0.2, 6); // shape kept
    const samsara = out[4] as Record<string, unknown>;
    expect(samsara.access_token).toBe('redacted');
    const pg = samsara.pagination as { endCursor: string; hasNextPage: boolean };
    expect(pg.endCursor).toMatch(/^c[0-9a-f]+$/);
    expect(s.scrubQuery(new URLSearchParams('after=b2Zmc2V0OjEwMA=='))).toEqual({
      after: pg.endCursor,
    });
    const vehicle = (samsara.data as Record<string, unknown>[])[0];
    expect(vehicle?.id).toMatch(/^\d{15}$/);
  });

  test('survivors: none in the scrubbed text; any original left is found', () => {
    const { s, out } = scrubbed();
    const text = JSON.stringify(out);
    expect(s.survivors(text)).toEqual([]);
    expect(s.survivors(`${text} {"id":"4475"}`)).toContain('4475');
    expect(s.survivors('{"principalId": 8348986}')).toContain('8348986');
    expect(s.survivors('/organizations/4475/fields')).toContain('4475');
    expect(s.survivors('"Smith Family Farms"')).toContain('Smith Family Farms');
    expect(s.originals()).toContain('8348986');
  });
});
