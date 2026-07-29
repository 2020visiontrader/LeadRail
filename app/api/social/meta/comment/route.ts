import { NextRequest, NextResponse } from 'next/server';
import { replyToComment, deleteComment, hideComment } from '@/lib/social/meta-engagement';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { commentId, action, message } = body;
    const accountId = session.accountId;
    if (!commentId || !action) return badRequest('commentId and action required');

    let result;
    switch (action) {
      case 'reply': {
        if (!message) return badRequest('message required for reply');
        result = await replyToComment(accountId, commentId, message, body.platform || 'facebook');
        break;
      }
      case 'delete': result = await deleteComment(accountId, commentId); break;
      case 'hide': result = await hideComment(accountId, commentId, true); break;
      case 'unhide': result = await hideComment(accountId, commentId, false); break;
      default: return badRequest('action must be reply, delete, hide, or unhide');
    }
    return NextResponse.json({ success: true, action, result });
  } catch (error: any) {
    return errorResponse(error);
  }
}
