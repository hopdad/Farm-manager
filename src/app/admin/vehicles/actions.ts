'use server';
/**
 * /admin/vehicles' server actions (slice 1f.2, terminal-pickups): set a vehicle's kind by hand,
 * or hand it back to the vendor's tags. requireRole(ROLE_FOR.admin) FIRST (manager and above; a
 * viewer, driver or operator is refused), then the write and ONE `fleet`/`invalidate`; an
 * ActionResult, never a throw to the client. The JSON route (./kind/route.ts) does the same for
 * scripts and the server-side refusal check.
 */
import { revalidatePath } from 'next/cache';
import { getPool } from '@/db/client';
import { requireRole } from '@/platform/auth/server';
import { isAuthError, ROLE_FOR } from '@/platform/auth/types';
import { KIND_LABELS } from '@/ui/map/fleet/style';
import { type ActionResult, actionResult } from '../action-result';
import { setVehicleKind, setVehicleKindRequestSchema } from './_lib/set-kind';

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

async function run(build: (form: FormData) => unknown, form: FormData): Promise<ActionResult> {
  try {
    await requireRole(ROLE_FOR.admin);
    const parsed = setVehicleKindRequestSchema.safeParse(build(form));
    if (!parsed.success) return actionResult(false, 'Pick a machine and one of the vehicle kinds.');
    const row = await setVehicleKind(getPool(), parsed.data);
    if (!row) return actionResult(false, 'That machine no longer exists.');
    revalidatePath('/admin/vehicles');
    const unit = text(form, 'unitNo') || 'the machine';
    return 'release' in parsed.data
      ? actionResult(true, `${unit}: its kind follows the vendor's tags again`)
      : actionResult(true, `${unit} is now a ${KIND_LABELS[row.kind].toLowerCase()} (set by hand)`);
  } catch (e) {
    if (isAuthError(e)) {
      return actionResult(
        false,
        e.status === 401
          ? 'Sign in first.'
          : 'Setting a vehicle kind needs a manager or the owner.',
      );
    }
    return actionResult(false, `Something went wrong: ${(e as Error).message}`);
  }
}

export async function setVehicleKindAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run((f) => ({ machineId: text(f, 'machineId'), kind: text(f, 'kind') }), form);
}

export async function releaseVehicleKindAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run((f) => ({ machineId: text(f, 'machineId'), release: true }), form);
}
