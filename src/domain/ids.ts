/**
 * Deterministic ids (plan §4): a row that comes from outside (or from the demo/sim world)
 * has primary key uuidv5(`${source}:${sourceId}`), so a re-sync on a reset PC or in
 * production recreates the same ids and hand-entered rows that point at them survive
 * data:export / data:import.
 *
 * Never change ID_NAMESPACE: every stored deterministic id depends on it.
 */
import { validate as uuidValidate, v5 as uuidv5 } from 'uuid';

export const ID_NAMESPACE = '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a19';

/** uuid v5 of `${source}:${sourceId}`. */
export function deterministicId(source: string, sourceId: string): string {
  if (!source || !sourceId) throw new Error('deterministicId needs a source and a sourceId');
  return uuidv5(`${source}:${sourceId}`, ID_NAMESPACE);
}

/** Id of a demo/sim-world entity (rows seeded with source = 'demo', source_id = key). */
export function demoId(key: string): string {
  return deterministicId('demo', key);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidValidate(value);
}
