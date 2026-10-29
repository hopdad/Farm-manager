/**
 * The operator layer on shared devices (D8: the wall and the cab/truck iPads): the person who
 * picked their name and entered their PIN there. Its own signed cookie (`farm_op`, ./tokens.ts),
 * bound to the device id, ending after PIN_RULES.operatorIdleMinutes without a page request
 * (src/proxy.ts slides it). The same code runs with either provider: only the device's base
 * credential comes from the provider.
 */
import { OPERATOR_COOKIE, sessionCookieOptions } from './cookies';
import { type OperatorClaims, signOperator, type TokenTimes, verifyOperator } from './tokens';
import { type CookieJar, PIN_RULES } from './types';

export const OPERATOR_TTL_SECONDS = PIN_RULES.operatorIdleMinutes * 60;

/** The verified operator layer of this browser, or null. */
export async function readOperator(
  secret: string,
  cookies: Pick<CookieJar, 'get'>,
  now: Date,
): Promise<{ operator: OperatorClaims; times: TokenTimes } | null> {
  return verifyOperator(secret, cookies.get(OPERATOR_COOKIE)?.value, now);
}

/** Put an operator on this device. */
export async function setOperator(
  secret: string,
  secure: boolean,
  cookies: CookieJar,
  op: OperatorClaims,
  now: Date,
): Promise<void> {
  const token = await signOperator(secret, op, now, OPERATOR_TTL_SECONDS);
  cookies.set(OPERATOR_COOKIE, token, sessionCookieOptions(secure, OPERATOR_TTL_SECONDS));
}

/** "Switch user": back to the bare device session. */
export function clearOperator(cookies: CookieJar): void {
  cookies.delete(OPERATOR_COOKIE);
}
