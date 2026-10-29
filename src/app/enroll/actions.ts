'use server';
/**
 * Enroll this browser with a one-time code (from /admin/devices: link, QR code or typed). The
 * code is the authorization: it was issued by a manager (requireRole(ROLE_FOR.manageDevices))
 * for one device, expires after an hour and works once.
 */
import { redirect } from 'next/navigation';
import { enrollBrowser } from '@/platform/auth/flows';
import type { LoginState } from '../login/actions';

export async function enrollAction(_prev: LoginState | null, form: FormData): Promise<LoginState> {
  const r = await enrollBrowser(form.get('code'));
  if (!r.ok) return { ok: false, message: r.message, at: Date.now() };
  redirect(r.home);
}
