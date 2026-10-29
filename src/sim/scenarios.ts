/**
 * The six scenarios (contracts §9) as day configurations over the shared farm.
 *
 *  - harvest-day   Oct 15 2026, 07:00 EDT: two combines with carts and four semis harvesting
 *                  this year's corn, trucks hauling to the nearest of three elevators.
 *  - breakdown     the same day; combine C2 breaks down at 10:20 and stays down; its cart
 *                  delivers what it holds and parks, the trucks shift to C1.
 *  - bad-morning   the same motion as harvest-day (identical samples), starting 05:45 so the
 *                  stand-in's 6 a.m. outage and vendor faults hit early. Faults are the
 *                  stand-in's job, not the world's.
 *  - planting-day  May 5 2026: the planter plants corn fields, the sprayer burns down ahead of
 *                  soybeans; everything else at the shop.
 *  - spray-windy   Jun 9 2026: the sprayer sprays soybeans at dawn, the wind comes up at 09:50
 *                  (no-go: it parks, engine off) and drops at 18:20, when it goes back to work.
 *  - winter-idle   Jan 15 2026: everything parked at the shop, engines off.
 *
 * A scenario runs day after day from its first day (the world chains day plans); days after
 * the first repeat the same routine on the next fields in each machine's list.
 */

import { dist, type Vec } from './geo/vec';
import type { DayContext } from './plan/context';
import type { DayWindow } from './plan/day';
import type { DayConfig } from './plan/simulate';
import { CURRENT_CROP_YEAR, cropFor, yieldFor } from './seasons';
import { hhmm } from './time';
import type { ScenarioName } from './types';

const SQ_M_PER_ACRE = 4046.86;

/** spray-windy: the no-go window on day 0 (local times). */
export const SPRAY_WINDY_HOLD = { from: '09:50', to: '18:20' } as const;
/** breakdown: which combine goes down, and when on day 0 (local). */
export const BREAKDOWN = { machineKey: 'combine-2', at: '10:20' } as const;

export interface ScenarioDef {
  name: ScenarioName;
  /** Local civil date of day 0. */
  epoch: { y: number; m: number; d: number };
  /** Sim instant the stand-in anchors its clock at on reset. */
  startsAt: string;
  /** Scenarios with the same motion key produce identical machine samples. */
  motion: string;
  dayConfig(ctx: DayContext, window: DayWindow, seed: number): DayConfig;
}

/** Greedy nearest-neighbour order of fields starting from a point. */
function tour(ctx: DayContext, fields: number[], from: Vec): number[] {
  const left = [...fields];
  const out: number[] = [];
  let at = from;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      const fi = ctx.fields[left[i] as number];
      const fb = ctx.fields[left[best] as number];
      if (fi && fb && dist(at, fi.entrance) < dist(at, fb.entrance)) best = i;
    }
    const [f] = left.splice(best, 1);
    out.push(f as number);
    at = ctx.fields[f as number]?.entrance ?? at;
  }
  return out;
}

function fieldsWithCrop(ctx: DayContext, seed: number, crop: 'corn' | 'soybeans'): number[] {
  const out = ctx.fields
    .filter((f) => cropFor(seed, f.field, CURRENT_CROP_YEAR) === crop)
    .map((f) => f.idx);
  return out.length ? out : ctx.fields.map((f) => f.idx);
}

/** This year's corn, split west / east of the shop: C1 takes the west, C2 the east. */
export function harvestGroups(ctx: DayContext, seed: number): [number[], number[]] {
  const corn = fieldsWithCrop(ctx, seed, 'corn');
  const shopX = ctx.shop.entrance.x;
  let west = corn.filter((i) => (ctx.fields[i]?.entrance.x ?? 0) < shopX);
  let east = corn.filter((i) => (ctx.fields[i]?.entrance.x ?? 0) >= shopX);
  if (!west.length || !east.length) {
    west = corn.filter((_, k) => k % 2 === 0);
    east = corn.filter((_, k) => k % 2 === 1);
  }
  return [tour(ctx, west, ctx.shop.entrance), tour(ctx, east, ctx.shop.entrance)];
}

function harvestConfig(
  ctx: DayContext,
  window: DayWindow,
  seed: number,
  breakdown?: { machineKey: string; at: string },
): DayConfig {
  const [west, east] = harvestGroups(ctx, seed);
  const yields = new Map<number, number>();
  return {
    harvest: {
      crews: [
        { combineKey: 'combine-1', cartKey: 'cart-1', fields: west },
        { combineKey: 'combine-2', cartKey: 'cart-2', fields: east },
      ],
      semiKeys: ['semi-1', 'semi-2', 'semi-3', 'semi-4'],
      combineDepartAt: window.at(hhmm('07:00')),
      cartDepartAt: window.at(hhmm('07:04')),
      semiDepartAt: ['07:20', '07:27', '07:34', '07:41'].map((x) => window.at(hhmm(x))),
      stopAt: window.at(hhmm('20:30')),
      ...(breakdown && window.index === 0
        ? { breakdown: { machineKey: breakdown.machineKey, at: window.at(hhmm(breakdown.at)) } }
        : {}),
      yieldBuPerM2(field) {
        let y = yields.get(field);
        if (y === undefined) {
          const f = ctx.fields[field];
          y = f ? yieldFor(seed, f.field, CURRENT_CROP_YEAR, 'corn') / SQ_M_PER_ACRE : 0;
          yields.set(field, y);
        }
        return y;
      },
    },
  };
}

export const SCENARIOS: Record<ScenarioName, ScenarioDef> = {
  'harvest-day': {
    name: 'harvest-day',
    epoch: { y: 2026, m: 10, d: 15 },
    startsAt: '2026-10-15T11:00:00.000Z',
    motion: 'harvest',
    dayConfig: (ctx, w, seed) => harvestConfig(ctx, w, seed),
  },
  'bad-morning': {
    name: 'bad-morning',
    epoch: { y: 2026, m: 10, d: 15 },
    startsAt: '2026-10-15T09:45:00.000Z',
    motion: 'harvest',
    dayConfig: (ctx, w, seed) => harvestConfig(ctx, w, seed),
  },
  breakdown: {
    name: 'breakdown',
    epoch: { y: 2026, m: 10, d: 15 },
    startsAt: '2026-10-15T11:00:00.000Z',
    motion: 'breakdown',
    dayConfig: (ctx, w, seed) => harvestConfig(ctx, w, seed, BREAKDOWN),
  },
  'planting-day': {
    name: 'planting-day',
    epoch: { y: 2026, m: 5, d: 5 },
    startsAt: '2026-05-05T11:15:00.000Z',
    motion: 'planting',
    dayConfig: (ctx, w, seed) => ({
      fieldwork: [
        {
          machineKey: 'planter-1',
          op: 'plant',
          fields: tour(ctx, fieldsWithCrop(ctx, seed, 'corn'), ctx.shop.entrance),
          departAt: w.at(hhmm('07:30')),
          stopAt: w.at(hhmm('20:00')),
          holds: [],
        },
        {
          machineKey: 'sprayer-1',
          op: 'spray',
          fields: tour(ctx, fieldsWithCrop(ctx, seed, 'soybeans'), ctx.shop.entrance),
          departAt: w.at(hhmm('07:15')),
          stopAt: w.at(hhmm('19:30')),
          holds: [],
        },
      ],
    }),
  },
  'spray-windy': {
    name: 'spray-windy',
    epoch: { y: 2026, m: 6, d: 9 },
    startsAt: '2026-06-09T10:00:00.000Z',
    motion: 'spray-windy',
    dayConfig: (ctx, w, seed) => ({
      fieldwork: [
        {
          machineKey: 'sprayer-1',
          op: 'spray',
          fields: tour(ctx, fieldsWithCrop(ctx, seed, 'soybeans'), ctx.shop.entrance),
          departAt: w.at(hhmm('06:15')),
          stopAt: w.at(hhmm('20:45')),
          holds:
            w.index === 0
              ? [{ from: w.at(hhmm(SPRAY_WINDY_HOLD.from)), to: w.at(hhmm(SPRAY_WINDY_HOLD.to)) }]
              : [],
        },
      ],
    }),
  },
  'winter-idle': {
    name: 'winter-idle',
    epoch: { y: 2026, m: 1, d: 15 },
    startsAt: '2026-01-15T14:00:00.000Z',
    motion: 'idle',
    dayConfig: () => ({}),
  },
};

/** When a scenario starts (what the stand-in anchors its clock at). */
export function scenarioStartsAt(name: ScenarioName): Date {
  return new Date(SCENARIOS[name].startsAt);
}
