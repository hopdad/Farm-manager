/**
 * Test seam for the server auth helpers: run code as a given session without cookies.
 *
 *   await runWithSession(makeSession({ role: 'driver' }), () => markDownAction(form));
 *
 * `getSession()` (./server.ts) returns the innermost override when one is active. Only code
 * running inside `fn` (same async context) sees it, so a request can never set it: it is safe
 * to leave in the production build, but import it from tests (and test helpers) only.
 * The auth builder keeps these exports when replacing server.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from './types';

const store = new AsyncLocalStorage<{ session: Session | null }>();

/** Run `fn` with getSession() returning `session` (null = signed out). */
export function runWithSession<T>(session: Session | null, fn: () => T): T {
  return store.run({ session }, fn);
}

/** The active override: a Session, null (signed out), or undefined when none is active. */
export function sessionOverride(): Session | null | undefined {
  return store.getStore()?.session;
}

/** A complete Session for tests; override any field. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    kind: 'person',
    deviceId: null,
    appUserId: null,
    partyId: null,
    role: 'viewer',
    displayName: 'Test user',
    deviceKind: null,
    provisional: false,
    ...overrides,
  };
}
