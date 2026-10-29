import { describe, expect, test } from 'vitest';
import {
  applyClockControl,
  clockStatus,
  createSimClock,
  initialClockState,
  reanchor,
} from './clock';
import type { SimClockState } from './types';

const wall = (iso: string) => new Date(iso);
const start = initialClockState({
  startsAt: new Date('2026-10-15T11:00:00Z'),
  wallNow: wall('2026-10-29T12:00:00Z'),
  speed: 30,
});
const simAt = (s: SimClockState, w: string) => createSimClock(s).wallToSim(wall(w)).toISOString();

describe('sim clock (the time rule)', () => {
  test('boots at startsAt and advances speed x wall time', () => {
    expect(simAt(start, '2026-10-29T12:00:00Z')).toBe('2026-10-15T11:00:00.000Z');
    expect(simAt(start, '2026-10-29T12:01:00Z')).toBe('2026-10-15T11:30:00.000Z');
    expect(createSimClock(start).speed).toBe(30);
    expect(createSimClock(start).paused).toBe(false);
  });

  test('SIM_FROZEN_AT boots paused there', () => {
    const frozen = initialClockState({
      startsAt: new Date('2026-10-15T11:00:00Z'),
      wallNow: wall('2026-10-29T12:00:00Z'),
      frozenAt: new Date('2026-10-15T15:00:00Z'),
    });
    expect(frozen.paused).toBe(true);
    expect(simAt(frozen, '2026-10-30T00:00:00Z')).toBe('2026-10-15T15:00:00.000Z');
  });

  test('pause freezes sim time where it is; resume continues from there', () => {
    const paused = applyClockControl(start, { action: 'pause' }, wall('2026-10-29T12:02:00Z'));
    expect(simAt(paused, '2026-10-29T13:00:00Z')).toBe('2026-10-15T12:00:00.000Z');
    const resumed = applyClockControl(paused, { action: 'resume' }, wall('2026-10-29T13:00:00Z'));
    expect(simAt(resumed, '2026-10-29T13:00:00Z')).toBe('2026-10-15T12:00:00.000Z');
    expect(simAt(resumed, '2026-10-29T13:00:10Z')).toBe('2026-10-15T12:05:00.000Z');
  });

  test('a speed change never jumps sim time', () => {
    const fast = applyClockControl(
      start,
      { action: 'speed', speed: 60 },
      wall('2026-10-29T12:01:00Z'),
    );
    expect(simAt(fast, '2026-10-29T12:01:00Z')).toBe('2026-10-15T11:30:00.000Z');
    expect(simAt(fast, '2026-10-29T12:02:00Z')).toBe('2026-10-15T12:30:00.000Z');
    expect(() =>
      applyClockControl(start, { action: 'speed', speed: 0 }, wall('2026-10-29T12:00:00Z')),
    ).toThrow(/speed/);
    expect(() =>
      applyClockControl(start, { action: 'speed', speed: 99999 }, wall('2026-10-29T12:00:00Z')),
    ).toThrow(/speed/);
  });

  test('jump and freeze move sim time; bad input is rejected', () => {
    const jumped = applyClockControl(
      start,
      { action: 'jump', simTime: '2026-10-15T18:00:00Z' },
      wall('2026-10-29T12:05:00Z'),
    );
    expect(simAt(jumped, '2026-10-29T12:05:00Z')).toBe('2026-10-15T18:00:00.000Z');
    expect(jumped.speed).toBe(30);
    const frozen = applyClockControl(
      start,
      { action: 'freeze', simTime: '2026-10-15T09:00:00Z' },
      wall('2026-10-29T12:05:00Z'),
    );
    expect(frozen.paused).toBe(true);
    expect(simAt(frozen, '2026-10-29T18:00:00Z')).toBe('2026-10-15T09:00:00.000Z');
    expect(() =>
      applyClockControl(start, { action: 'jump', simTime: 'soon' }, wall('2026-10-29T12:00:00Z')),
    ).toThrow(/ISO/);
    expect(() =>
      applyClockControl(start, { action: 'rewind' } as never, wall('2026-10-29T12:00:00Z')),
    ).toThrow(/unknown/);
  });

  test('re-anchoring keeps behaviour; status reports sim and wall now', () => {
    const r = reanchor(start, wall('2026-10-29T12:10:00Z'));
    expect(r.anchorWall).toBe('2026-10-29T12:10:00.000Z');
    expect(simAt(r, '2026-10-29T12:20:00Z')).toBe(simAt(start, '2026-10-29T12:20:00Z'));
    expect(clockStatus(start, wall('2026-10-29T12:01:00Z'))).toMatchObject({
      simNow: '2026-10-15T11:30:00.000Z',
      wallNow: '2026-10-29T12:01:00.000Z',
      speed: 30,
      paused: false,
    });
  });
});
