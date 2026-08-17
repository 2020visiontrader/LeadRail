import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { createPost } from '@/lib/social/buffer';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { channelId, text, dueAt, draft } = body;
    if (!channelId || !text) return badRequest('channelId and text required');
    // Packet 7.2: publishes with THIS account's Buffer credential, not a
    // deployment-wide one.
    const result = await createPost(session.accountId, channelId, text, dueAt, draft ?? false);
    return NextResponse.json({ success: true, result }, { status: 201 });
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/social/buffer/create", method: "POST" });
