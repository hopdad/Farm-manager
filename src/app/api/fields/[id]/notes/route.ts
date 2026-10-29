/**
 * PUT /api/fields/<id>/notes `{ text, version }`: save the field's notes (manager and owner,
 * ROLE_FOR.editFieldNotes, checked first on the server), optimistic on `version`, publishing
 * `fields`/`updated` `{ fieldId, parts: ['notes'] }` on commit. Logic: ../../handler.ts.
 */
import { getDb } from '@/db/client';
import { handleSaveNotes } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSaveNotes(request, id, getDb());
}
