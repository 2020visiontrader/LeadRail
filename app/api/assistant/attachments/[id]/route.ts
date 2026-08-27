import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { deleteAttachment, attachmentUrl, updateAttachment, ATTACHMENT_SCOPES } from '@/lib/documents/attachments';

export const dynamic = 'force-dynamic';

// GET /api/assistant/attachments/:id — a short-lived signed URL for the file.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    // Account-scoped in the query, so an id from another tenant reads as
    // missing rather than as a file.
    const url = await attachmentUrl(session.accountId, params.id);
    if (!url) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ url });
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/assistant/attachments/:id — rename or re-scope one attachment.
// Renaming and library toggling are the same endpoint because they are the
// same gesture from the settings panel: "edit how this document is known and
// where it reaches." Splitting them into two routes would double the
// boilerplate for no behavioural difference.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    const patch: { scope?: string; title?: string | null } = {};

    if (body?.scope !== undefined) {
      if (typeof body.scope !== 'string' || !ATTACHMENT_SCOPES.includes(body.scope)) {
        return badRequest(`scope must be one of: ${ATTACHMENT_SCOPES.join(', ')}`);
      }
      patch.scope = body.scope;
    }

    if (body?.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        return badRequest('title must be a string or null');
      }
      patch.title = body.title;
    }

    if (!Object.keys(patch).length) return badRequest('nothing to update');

    // Account-scoped in the query, same as GET/DELETE above: an id belonging
    // to another tenant returns 404 rather than revealing whether it exists —
    // no existence oracle for ids the caller does not own.
    const updated = await updateAttachment(session.accountId, params.id, patch);
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ attachment: updated });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/assistant/attachments/:id — remove the row and the bytes.
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    await deleteAttachment(session.accountId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/assistant/attachments/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/assistant/attachments/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/assistant/attachments/[id]', method: 'DELETE' });
