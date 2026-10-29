/** Machines that sit together on screen share one label. */
import { describe, expect, test } from 'vitest';
import { groupLabels } from './labels';
import type { FleetFrame } from './model';

const frame = (
  unitNo: string,
  kind: FleetFrame['kind'],
  x: number,
  over: Partial<FleetFrame> = {},
) =>
  ({
    id: unitNo,
    unitNo,
    kind,
    activity: 'working',
    status: 'active',
    positionSource: 'eld',
    speedMph: 3,
    ts: '2026-10-29T14:00:00Z',
    lng: x,
    lat: 0,
    heading: 0,
    stale: false,
    ...over,
  }) as FleetFrame;

/** lng doubles as the screen x (px). */
const project = (lng: number) => ({ x: lng, y: 0 });

describe('groupLabels', () => {
  test('a combine, its cart and a semi in one field: one label under the combine', () => {
    const groups = groupLabels(
      [frame('S4', 'semi', 30), frame('GC1', 'grain_cart', 12), frame('C1', 'combine', 0)],
      project,
      48,
      null,
    );
    expect(groups.map((g) => [g.anchor.unitNo, g.text])).toEqual([['C1', 'C1 · GC1 · S4']]);
  });

  test('apart machines keep their own labels; the selected one anchors its group', () => {
    const groups = groupLabels(
      [
        frame('C1', 'combine', 0),
        frame('GC1', 'grain_cart', 20),
        frame('T2', 'tractor', 500, { status: 'down' }),
      ],
      project,
      48,
      'GC1',
    );
    expect(groups.map((g) => g.text).sort()).toEqual(['GC1 · C1', 'T2 down']);
  });

  test('chains group transitively; all stale is flagged', () => {
    const groups = groupLabels(
      [
        frame('S1', 'semi', 0, { stale: true }),
        frame('S2', 'semi', 40, { stale: true }),
        frame('S3', 'semi', 80, { stale: true }),
      ],
      project,
      48,
      null,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ text: 'S1 stale · S2 stale · S3 stale', allStale: true });
  });
});
