import { describe, expect, test } from 'vitest';
import { machineNear } from './pick';

// A flat projection: 1000 px per degree, y down.
const project = ([lng, lat]: [number, number]) => ({ x: lng * 1000, y: -lat * 1000 });

describe('machineNear', () => {
  const frames = [
    { lng: 1, lat: -1 }, // (1000, 1000)
    { lng: 2, lat: -2 }, // (2000, 2000)
  ];

  test('a tap within reach of a machine: the GPU pick runs', () => {
    expect(machineNear(frames, project, { x: 1010, y: 1020 }, 36)).toBe(true);
    expect(machineNear(frames, project, { x: 2000, y: 2036 }, 36)).toBe(true);
  });

  test('a tap away from every machine (a field tap): no GPU pick', () => {
    expect(machineNear(frames, project, { x: 1500, y: 1500 }, 36)).toBe(false);
    expect(machineNear(frames, project, { x: 1000, y: 1037 }, 36)).toBe(false);
  });

  test('no machines on the map', () => {
    expect(machineNear([], project, { x: 0, y: 0 }, 1000)).toBe(false);
  });
});
