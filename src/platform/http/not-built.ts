/**
 * The answer of a route whose builder hasn't landed yet (slice 2a foundation stubs,
 * docs/contracts-2a.md §5): 501 `{ error, route }`, no-store, through the 4 MB response guard
 * like every API route. Each stub route file is replaced by its owner's handler.
 */
import { limitedJson } from './limits';

export function notBuiltYet(route: string): Response {
  return limitedJson(
    { error: 'not built yet', route },
    { status: 501, headers: { 'cache-control': 'no-store' } },
    { route },
  );
}
