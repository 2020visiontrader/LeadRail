import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { sendInboxReply } from '@/lib/inbox/reply-send';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    if (!body?.subject) return badRequest('subject is required');
    if (!body?.body) return badRequest('body is required');
    const result = await sendInboxReply({
      accountId: session.accountId,
      inboxMessageId: ctx.params.id,
      subject: body.subject,
      bodyHtml: body.body,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/inbox/[id]/send", method: "POST" });
