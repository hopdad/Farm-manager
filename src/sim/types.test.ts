import { describe, expect, test } from 'vitest';
import { type SimClockState, wallToSim } from './types';

describe('wallToSim (the normative clock arithmetic)', () => {
  const state: SimClockState = {
    anchorWall: '2026-10-28T12:00:00.000Z',
    anchorSim: '2026-10-15T11:00:00.000Z',
    speed: 30,
    paused: false,
  };

  test('advances speed x wall time from the anchor', () => {
    expect(wallToSim(state, new Date('2026-10-28T12:01:00Z')).toISOString()).toBe(
      '2026-10-15T11:30:00.000Z',
    );
  });

  test('paused returns the anchor sim time whatever the wall time', () => {
    const paused = { ...state, paused: true };
    expect(wallToSim(paused, new Date('2026-10-28T18:00:00Z')).toISOString()).toBe(
      '2026-10-15T11:00:00.000Z',
    );
  });

  test('real time at speed 1', () => {
    const rt = { ...state, speed: 1 };
    expect(wallToSim(rt, new Date('2026-10-28T12:00:05Z')).toISOString()).toBe(
      '2026-10-15T11:00:05.000Z',
    );
  });
});
