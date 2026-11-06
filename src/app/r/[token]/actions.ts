'use server';
/**
 * The POST of a customer request link, /r/<token> (job-forms, decision 2a-9; docs/contracts-2a.md
 * §5.5). No session: the token is the authorization (the page is in PUBLIC_PAGE_PATHS). The token
 * and every value are checked again here; a request becomes a `requested` job
 * (src/db/queries/request-links.ts submitLinkRequest: at most REQUEST_LINK_MAX_PER_DAY per link
 * per farm day, last_used_at touched). Next's own Origin check guards the action against
 * cross-site posts. Never throws to the client.
 */
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import {
  linkRequestSchema,
  requestDatesProblem,
  submitLinkRequest,
} from '@/db/queries/request-links';

export type RequestFormState =
  | { status: 'done'; at: number }
  /** The link doesn't work any more (revoked, or never was one). */
  | { status: 'refused'; at: number }
  /** The link took its requests for today. */
  | { status: 'limit'; at: number }
  | { status: 'invalid'; message: string; field: string | null; at: number }
  | { status: 'failed'; message: string; at: number };

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

const capital = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);

export async function submitRequestAction(
  _prev: RequestFormState | null,
  form: FormData,
): Promise<RequestFormState> {
  const at = Date.now();
  // A field people never see: a bot that fills every input gets a thank-you and nothing is made.
  if (text(form, 'website').trim() !== '') return { status: 'done', at };
  const parsed = linkRequestSchema.safeParse({
    kind: text(form, 'kind'),
    fieldId: text(form, 'fieldId'),
    where: text(form, 'where'),
    from: text(form, 'from'),
    by: text(form, 'by'),
    notes: text(form, 'notes'),
    name: text(form, 'name'),
    phone: text(form, 'phone'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'invalid',
      message: `${capital(issue?.message ?? 'check the form')}.`,
      field: typeof issue?.path[0] === 'string' ? issue.path[0] : null,
      at,
    };
  }
  const now = new Date();
  const dates = requestDatesProblem(parsed.data, now);
  if (dates) return { status: 'invalid', message: `${capital(dates)}.`, field: 'from', at };
  try {
    const r = await submitLinkRequest(
      getPool(),
      getConfig().SESSION_SECRET,
      text(form, 'token'),
      parsed.data,
      now,
    );
    switch (r.status) {
      case 'created':
        return { status: 'done', at };
      case 'refused':
        return { status: 'refused', at };
      case 'limit':
        return { status: 'limit', at };
      case 'bad_field':
        return {
          status: 'invalid',
          message: 'That field isn’t on your list any more: pick another or say where.',
          field: 'fieldId',
          at,
        };
    }
  } catch (e) {
    console.error('[r] request failed:', (e as Error).message);
    return {
      status: 'failed',
      message: 'We couldn’t save that just now. Try again in a minute, or call us.',
      at,
    };
  }
}
