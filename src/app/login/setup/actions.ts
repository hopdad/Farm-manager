'use server';
/**
 * /login/setup: the first-run owner link and the `pnpm auth:reset-owner` recovery link. No
 * session is needed (that is the point); the code in the link is the authorization: the setup
 * code works only while the farm has no owner, a reset code once and for 30 minutes.
 */
import { redirect } from 'next/navigation';
import { resetOwnerFlow, setupOwnerFlow } from '@/platform/auth/flows';
import type { LoginState } from '../actions';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

const refused = (message: string): LoginState => ({ ok: false, message, at: Date.now() });

function checkPins(form: FormData): string | null {
  const pin = field(form, 'pin');
  if (pin !== field(form, 'pin2')) return 'The two PINs are different.';
  return null;
}

export async function setupOwnerAction(
  _prev: LoginState | null,
  form: FormData,
): Promise<LoginState> {
  const mismatch = checkPins(form);
  if (mismatch) return refused(mismatch);
  const r = await setupOwnerFlow(field(form, 'code'), field(form, 'name'), field(form, 'pin'));
  if (!r.ok) return refused(r.message);
  redirect(r.home);
}

export async function resetOwnerAction(
  _prev: LoginState | null,
  form: FormData,
): Promise<LoginState> {
  const mismatch = checkPins(form);
  if (mismatch) return refused(mismatch);
  const r = await resetOwnerFlow(field(form, 'reset'), field(form, 'ownerId'), field(form, 'pin'));
  if (!r.ok) return refused(r.message);
  redirect(r.home);
}
