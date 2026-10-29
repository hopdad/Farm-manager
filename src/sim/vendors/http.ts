/**
 * Tiny request/response model for the vendor stand-in's routes. Routes are plain functions
 * `(req, ctx) => SimResponse` (no framework), so each vendor's behaviour is unit-testable and
 * the server (./server.ts) owns all socket handling.
 */
import type { IncomingHttpHeaders } from 'node:http';

export interface SimRequest {
  method: string;
  /** Full URL as the client sent it (host from the Host header). */
  url: URL;
  /** Path below the vendor root, e.g. '/fleet/vehicles/locations/feed'. */
  path: string;
  headers: IncomingHttpHeaders;
  /** Raw body text ('' for GET). */
  body: string;
  /** Per-vendor request sequence number. */
  seq: number;
}

export type SimResponse =
  | {
      kind: 'reply';
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  /** Drop the socket without answering (outage), optionally after a delay (timeout). */
  | { kind: 'drop'; afterMs?: number };

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): SimResponse {
  return {
    kind: 'reply',
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

export function html(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): SimResponse {
  return {
    kind: 'reply',
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body,
  };
}

/** A 302 (the stand-in is the vendor here; the app's own routes never answer 3xx). */
export function redirect(location: string): SimResponse {
  return { kind: 'reply', status: 302, headers: { location }, body: '' };
}

export function drop(afterMs?: number): SimResponse {
  return afterMs ? { kind: 'drop', afterMs } : { kind: 'drop' };
}

/** HTML-escape text for the consent page. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The bearer token of an `Authorization: Bearer …` header, or null. */
export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const h = headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** `application/x-www-form-urlencoded` body → params. */
export function formBody(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

/** One header value (first of a repeated header). */
export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
