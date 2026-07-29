import { NextRequest, NextResponse } from 'next/server';
import { createPost } from '@/lib/social/buffer';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { channelId, text, dueAt, draft } = body;
    if (!channelId || !text) return badRequest('channelId and text required');
    const result = await createPost(channelId, text, dueAt, draft ?? false);
    return NextResponse.json({ success: true, result }, { status: 201 });
  } catch (error: any) {
    return errorResponse(error);
  }
}
