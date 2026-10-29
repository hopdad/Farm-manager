'use server';
/**
 * Realtime diagnostics on /admin/realtime:
 *  - send a test event: `admin`/`invalidate { reason: 'changed', event: 'test:<marker>' }` reaches
 *    every open screen (phones included) through the normal path; admin pages just refresh;
 *  - drop the LISTEN connection (not in production): the hub reconnects and every connected
 *    client resyncs, which is what a database restart looks like.
 * Both need the admin cookie (src/platform/auth/admin-key.ts).
 */
import { z } from 'zod';
import { getConfig } from '@/config';
import { ADMIN_LOCKED_MESSAGE } from '@/platform/auth/admin-key';
import { getRealtimeHub } from '@/platform/realtime/hub';
import { publish } from '@/platform/realtime/publish';
import { adminUnlocked } from '../_lib/guard';
import { type ActionResult, actionResult } from '../action-result';

const marker = z.string().regex(/^[a-z0-9-]{8,64}$/);

export async function sendTestEventAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (!(await adminUnlocked())) return actionResult(false, ADMIN_LOCKED_MESSAGE);
  try {
    const m = marker.parse(form.get('marker'));
    const r = await publish('admin', 'invalidate', { reason: 'changed', event: `test:${m}` });
    return actionResult(true, `test event sent (${m}, ${r.bytes} bytes)`);
  } catch (e) {
    return actionResult(false, e instanceof z.ZodError ? 'invalid marker' : (e as Error).message);
  }
}

export async function dropListenAction(
  _prev: ActionResult | null,
  _form: FormData,
): Promise<ActionResult> {
  if (!(await adminUnlocked())) return actionResult(false, ADMIN_LOCKED_MESSAGE);
  const cfg = getConfig();
  if (cfg.isProduction || cfg.NEXT_PUBLIC_REALTIME !== 'sse') {
    return actionResult(false, 'only for the local SSE adapter');
  }
  return getRealtimeHub().reconnect('dropped from /admin/realtime')
    ? actionResult(true, 'LISTEN connection dropped: it reconnects and clients resync')
    : actionResult(false, 'the LISTEN connection is not up');
}
