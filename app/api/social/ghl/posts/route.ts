import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listPosts, deletePost, getPostAnalytics, resolveGhlLocationId } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId')
      || (await resolveGhlLocationId(session.accountId));
    const accountId = request.nextUrl.searchParams.get('accountId') || undefined;
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '20', 10);
    const postId = request.nextUrl.searchParams.get('postId');
    if (!locationId) return badRequest('locationId required (none configured for this account)');
    if (postId) return NextResponse.json(await getPostAnalytics(locationId, postId));
    return NextResponse.json(await listPosts(locationId, accountId, limit));
  } catch (error: any) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId')
      || (await resolveGhlLocationId(session.accountId));
    const postId = request.nextUrl.searchParams.get('postId');
    if (!locationId || !postId) return badRequest('locationId and postId required');
    return NextResponse.json(await deletePost(locationId, postId));
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/ghl/posts", method: "GET" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/social/ghl/posts", method: "DELETE" });
