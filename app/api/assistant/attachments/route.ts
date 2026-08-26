import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { ingestAttachment, listAttachments, MAX_UPLOAD_BYTES } from '@/lib/documents/attachments';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
// Parsing a large PDF is not a 10-second job, and the default would cut it off
// mid-extraction and report a generic failure.
export const maxDuration = 60;

// GET /api/assistant/attachments?conversationId= — what is attached here.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const conversationId = request.nextUrl.searchParams.get('conversationId');
    return NextResponse.json({ attachments: await listAttachments(session.accountId, conversationId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/assistant/attachments — upload one document for context.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return badRequest('no file was uploaded');

    // Size is checked against the ACTUAL bytes, after reading, not against a
    // Content-Length the client sets. A header is a claim, not a measurement.
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return badRequest(`that file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`);
    }

    const attachment = await ingestAttachment({
      accountId: session.accountId,
      conversationId: (form.get('conversationId') as string) || null,
      filename: file.name || 'upload',
      bytes,
      mimeType: file.type || undefined,
    });
    return NextResponse.json({ attachment });
  } catch (e: any) {
    // Deliberately NOT errorResponse here. Every failure on this path is one
    // the person can act on — wrong file type, too large, storage not set up —
    // and flattening those to "Internal error" tells them nothing and tells us
    // nothing either. The messages are ours, authored for this purpose; the
    // one that embeds a storage error is truncated.
    const message = String(e?.message || 'Could not read that file.').slice(0, 300);
    log.error('attachment upload failed', e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/assistant/attachments', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/assistant/attachments', method: 'POST' });
