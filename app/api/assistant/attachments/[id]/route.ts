import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { deleteAttachment, attachmentUrl } from '@/lib/documents/attachments';

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
export const DELETE = withApi(DELETE__impl as any, { route: '/api/assistant/attachments/[id]', method: 'DELETE' });
