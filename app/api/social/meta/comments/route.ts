import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getComments } from '@/lib/social/meta-engagement';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const postId = request.nextUrl.searchParams.get('postId');
    const platform = request.nextUrl.searchParams.get('platform') as 'facebook' | 'instagram';
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '25', 10);
    if (!postId || !platform) return badRequest('postId and platform required');
    const comments = await getComments(session.accountId, postId, platform, limit);
    return NextResponse.json(comments);
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/meta/comments", method: "GET" });
