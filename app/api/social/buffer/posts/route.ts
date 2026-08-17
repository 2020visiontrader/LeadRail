import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listPosts, getPost, deletePost } from '@/lib/social/buffer';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    // Packet 7.2: the Buffer credential is resolved from the session's account.
    // `orgId` stays a client argument, but it can only address Buffer
    // organisations this account's own token is authorised for.
    const orgId = request.nextUrl.searchParams.get('orgId');
    const postId = request.nextUrl.searchParams.get('postId');
    const status = request.nextUrl.searchParams.get('status') || undefined;
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '20', 10);
    if (postId) return NextResponse.json(await getPost(session.accountId, postId));
    if (!orgId) return badRequest('orgId required');
    return NextResponse.json(await listPosts(session.accountId, orgId, status, limit));
  } catch (error: any) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const postId = request.nextUrl.searchParams.get('postId');
    if (!postId) return badRequest('postId required');
    return NextResponse.json(await deletePost(session.accountId, postId));
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/buffer/posts", method: "GET" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/social/buffer/posts", method: "DELETE" });
