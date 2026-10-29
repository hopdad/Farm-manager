import { describe, expect, test } from 'vitest';
import { wallToSim } from '../types';
import {
  applyClockRequest,
  ClockRequestError,
  clockStatus,
  currentClock,
  MAX_CLOCK_SEGMENTS,
  simAt,
  simClockOf,
  startTimeline,
} from './clock';

const W0 = new Date('2026-10-29T12:00:00.000Z');
const S0 = new Date('2026-10-15T11:00:00.000Z');
const at = (ms: number) => new Date(W0.getTime() + ms);

describe('sim clock timeline', () => {
  test('a fresh timeline runs from the scenario start at the given speed', () => {
    const tl = startTimeline(S0, W0, { speed: 30 });
    expect(simAt(tl, at(10_000)).toISOString()).toBe(
      new Date(S0.getTime() + 300_000).toISOString(),
    );
    expect(simAt(tl, at(10_000))).toEqual(wallToSim(currentClock(tl), at(10_000)));
  });

  test('pause freezes sim time; resume continues from the frozen instant', () => {
    let tl = startTimeline(S0, W0, { speed: 2 });
    tl = applyClockRequest(tl, { action: 'pause' }, at(10_000)); // sim = S0 + 20 s
    expect(currentClock(tl).paused).toBe(true);
    expect(simAt(tl, at(60_000)).getTime()).toBe(S0.getTime() + 20_000);
    tl = applyClockRequest(tl, { action: 'resume' }, at(60_000));
    expect(simAt(tl, at(70_000)).getTime()).toBe(S0.getTime() + 40_000);
  });

  test('past wall instants keep the clock that was in effect then', () => {
    let tl = startTimeline(S0, W0, { speed: 1 });
    tl = applyClockRequest(tl, { action: 'speed', speed: 60 }, at(10_000));
    // Before the change: 1x. After: 60x from the re-anchor.
    expect(simAt(tl, at(5_000)).getTime()).toBe(S0.getTime() + 5_000);
    expect(simAt(tl, at(11_000)).getTime()).toBe(S0.getTime() + 10_000 + 60_000);
  });

  test('jump and freeze move sim time; freeze also pauses', () => {
    let tl = startTimeline(S0, W0);
    tl = applyClockRequest(tl, { action: 'jump', simTime: '2026-10-15T15:00:00Z' }, at(1000));
    expect(simAt(tl, at(2000)).toISOString()).toBe('2026-10-15T15:00:01.000Z');
    tl = applyClockRequest(tl, { action: 'freeze', simTime: '2026-10-15T06:00:00Z' }, at(3000));
    expect(simAt(tl, at(999_999)).toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(simClockOf(tl).paused).toBe(true);
  });

  test('two changes in the same millisecond keep only the later segment', () => {
    let tl = startTimeline(S0, W0);
    tl = applyClockRequest(tl, { action: 'pause' }, at(1000));
    tl = applyClockRequest(tl, { action: 'resume' }, at(1000));
    expect(tl).toHaveLength(2);
    expect(currentClock(tl).paused).toBe(false);
  });

  test('rejects bad speeds and dates; keeps a bounded history', () => {
    const tl = startTimeline(S0, W0);
    expect(() => applyClockRequest(tl, { action: 'speed', speed: 0 }, at(1))).toThrow(
      ClockRequestError,
    );
    expect(() => applyClockRequest(tl, { action: 'jump', simTime: 'nope' }, at(1))).toThrow(
      ClockRequestError,
    );
    let long = tl;
    for (let i = 1; i <= MAX_CLOCK_SEGMENTS + 20; i++) {
      long = applyClockRequest(long, { action: i % 2 ? 'pause' : 'resume' }, at(i));
    }
    expect(long).toHaveLength(MAX_CLOCK_SEGMENTS);
  });

  test('status reports sim and wall now', () => {
    const tl = startTimeline(S0, W0, { speed: 10 });
    const s = clockStatus(tl, at(1000));
    expect(s).toMatchObject({ speed: 10, paused: false, wallNow: at(1000).toISOString() });
    expect(s.simNow).toBe(new Date(S0.getTime() + 10_000).toISOString());
  });
});
