import { NextRequest, NextResponse } from 'next/server';
import { createPost } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { locationId, summary, accountIds, scheduleDate, media } = body;
    if (!locationId || !summary) return badRequest('locationId and summary required');
    const result = await createPost(locationId, summary, accountIds, scheduleDate, media);
    return NextResponse.json({ success: true, result }, { status: 201 });
  } catch (error: any) {
    return errorResponse(error);
  }
}
