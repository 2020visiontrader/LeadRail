import { NextRequest, NextResponse } from 'next/server';
import { listPosts, getPost, deletePost } from '@/lib/social/buffer';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const orgId = request.nextUrl.searchParams.get('orgId');
    const postId = request.nextUrl.searchParams.get('postId');
    const status = request.nextUrl.searchParams.get('status') || undefined;
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '20', 10);
    if (postId) return NextResponse.json(await getPost(postId));
    if (!orgId) return badRequest('orgId required');
    return NextResponse.json(await listPosts(orgId, status, limit));
  } catch (error: any) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const postId = request.nextUrl.searchParams.get('postId');
    if (!postId) return badRequest('postId required');
    return NextResponse.json(await deletePost(postId));
  } catch (error: any) {
    return errorResponse(error);
  }
}
