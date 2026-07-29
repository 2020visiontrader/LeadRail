import { NextRequest, NextResponse } from 'next/server';
import { listPosts, deletePost, getPostAnalytics } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId');
    const accountId = request.nextUrl.searchParams.get('accountId') || undefined;
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '20', 10);
    const postId = request.nextUrl.searchParams.get('postId');
    if (!locationId) return badRequest('locationId required');
    if (postId) return NextResponse.json(await getPostAnalytics(locationId, postId));
    return NextResponse.json(await listPosts(locationId, accountId, limit));
  } catch (error: any) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId');
    const postId = request.nextUrl.searchParams.get('postId');
    if (!locationId || !postId) return badRequest('locationId and postId required');
    return NextResponse.json(await deletePost(locationId, postId));
  } catch (error: any) {
    return errorResponse(error);
  }
}
