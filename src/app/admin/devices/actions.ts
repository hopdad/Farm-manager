'use server';
/**
 * Server actions behind /admin/devices. requireRole(ROLE_FOR.manageDevices) FIRST in each; the
 * store re-checks phones bound to a person (binding a manager's or the owner's phone needs the
 * right to manage that person: a phone signs in as its person). Issuing a code returns it once
 * (only its hash is stored) with the link and QR code for the device to open.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getConfig } from '@/config';
import { getDb } from '@/db/client';
import type { DeviceKind } from '@/domain/farm';
import { formatEnrollCode } from '@/platform/auth/codes';
import { isLoopbackHost, privateAddresses } from '@/platform/auth/lan';
import { DEFAULT_DEVICE_ROLE, isDeviceKind } from '@/platform/auth/policy';
import { qrSvgPath } from '@/platform/auth/qr';
import { requireRole } from '@/platform/auth/server';
import {
  AuthStoreError,
  createDevice,
  type IssuedCode,
  issueEnrollCode,
  revokeDevice,
  updateDevice,
} from '@/platform/auth/store';
import { isAuthError, ROLE_FOR, type Session } from '@/platform/auth/types';
import { type ActionResult, actionResult as result } from '../action-result';

const PATH = '/admin/devices';

export interface EnrollCodeView {
  deviceName: string;
  kind: DeviceKind;
  /** K7QD2-M9XPA */
  code: string;
  /** The link as this browser reached the app (scan or open it on the device). */
  url: string;
  /** The same link on the PC's LAN addresses, when this browser used localhost. */
  lanUrls: string[];
  qr: { size: number; path: string };
  expiresAt: string;
}

export interface DeviceActionResult extends ActionResult {
  enroll?: EnrollCodeView;
}

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function attempt(
  fn: (s: Session) => Promise<{ message: string; enroll?: EnrollCodeView }>,
): Promise<DeviceActionResult> {
  let session: Session;
  try {
    session = await requireRole(ROLE_FOR.manageDevices);
  } catch (e) {
    if (isAuthError(e)) {
      return result(
        false,
        e.status === 401 ? 'Sign in first.' : `This needs the ${e.required} role or above.`,
      );
    }
    throw e;
  }
  try {
    const r = await fn(session);
    revalidatePath(PATH);
    return { ...result(true, r.message), ...(r.enroll ? { enroll: r.enroll } : {}) };
  } catch (e) {
    if (e instanceof AuthStoreError) return result(false, e.message);
    console.error('[admin/devices]', (e as Error).message);
    return result(false, 'That failed on the server; try again.');
  }
}

/** The origin this request came in on (the browser's view of the app). */
async function requestOrigin(): Promise<{ origin: string; host: string; port: string }> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? new URL(getConfig().PUBLIC_URL).host;
  const proto =
    h.get('x-forwarded-proto') ?? new URL(getConfig().PUBLIC_URL).protocol.replace(':', '');
  const u = new URL(`${proto}://${host}`);
  return { origin: u.origin, host: u.hostname, port: u.port };
}

async function codeView(issued: IssuedCode): Promise<EnrollCodeView> {
  const { origin, host, port } = await requestOrigin();
  const link = (base: string) => `${base}/enroll?code=${issued.code}`;
  const url = link(origin);
  const proto = new URL(origin).protocol;
  return {
    deviceName: issued.device.name,
    kind: issued.device.kind,
    code: formatEnrollCode(issued.code),
    url,
    lanUrls: isLoopbackHost(host)
      ? privateAddresses().map((ip) => link(`${proto}//${ip}${port ? `:${port}` : ''}`))
      : [],
    qr: qrSvgPath(url),
    expiresAt: issued.expiresAt.toISOString(),
  };
}

/** Add a device and show its first one-time code. */
export async function addDeviceAction(
  _prev: DeviceActionResult | null,
  form: FormData,
): Promise<DeviceActionResult> {
  return attempt(async (s) => {
    const kind = field(form, 'kind');
    if (!isDeviceKind(kind)) throw new AuthStoreError('invalid', 'pick what kind of device it is');
    const issued = await createDevice(
      getDb(),
      s,
      getConfig().SESSION_SECRET,
      {
        name: field(form, 'name'),
        kind,
        role: field(form, 'role') || DEFAULT_DEVICE_ROLE[kind],
        appUserId: field(form, 'appUserId') || null,
      },
      new Date(),
    );
    return {
      message: `${issued.device.name} added: open the code on the device`,
      enroll: await codeView(issued),
    };
  });
}

/** A new one-time code for an existing device (re-enroll, or the last one expired). */
export async function newCodeAction(
  _prev: DeviceActionResult | null,
  form: FormData,
): Promise<DeviceActionResult> {
  return attempt(async (s) => {
    const issued = await issueEnrollCode(
      getDb(),
      s,
      getConfig().SESSION_SECRET,
      field(form, 'id'),
      new Date(),
    );
    return { message: `New code for ${issued.device.name}`, enroll: await codeView(issued) };
  });
}

/** What a device may do on its own (viewer, driver, operator). */
export async function setDeviceRoleAction(
  _prev: DeviceActionResult | null,
  form: FormData,
): Promise<DeviceActionResult> {
  return attempt(async () => {
    const d = await updateDevice(getDb(), field(form, 'id'), { role: field(form, 'role') });
    return { message: `${d.name} is now a ${d.role} on its own` };
  });
}

/** Revoke: the device's cookies stop working on its next request (lost or replaced iPads). */
export async function revokeDeviceAction(
  _prev: DeviceActionResult | null,
  form: FormData,
): Promise<DeviceActionResult> {
  return attempt(async () => {
    const ok = await revokeDevice(getDb(), field(form, 'id'), new Date());
    return { message: ok ? 'Revoked: it is signed out now' : 'Already revoked' };
  });
}
