/**
 * Requests for the job routes' DB tests (slice 2a, jobs-api). Tests only: the routes never
 * import it. (Each test file runs its calls under runWithSession itself: only tests may import
 * the auth test seam, src/seams.test.ts.)
 */

export const TEST_HOST = 'localhost:3121';
export const TEST_ORIGIN = `http://${TEST_HOST}`;

/** A same-origin JSON request (override headers to test the refusals). */
export function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${TEST_ORIGIN}${path}`, {
    method,
    headers: {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export async function bodyOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
