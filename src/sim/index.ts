/**
 * Simulator entry point: PLACEHOLDER. The sim agent replaces the bodies (deterministic world,
 * scenarios) and keeps these exports, so the vendor stand-in and the seed can code against
 * them in parallel. See ./types.ts for the contract and the time rule.
 */
import type { BuildSimFarm, CreateSimWorld } from './types';

export * from './types';

export const buildSimFarm: BuildSimFarm = () => {
  throw new Error('buildSimFarm: not implemented yet (sim stage)');
};

export const createSimWorld: CreateSimWorld = () => {
  throw new Error('createSimWorld: not implemented yet (sim stage)');
};
