import { NextRequest, NextResponse } from 'next/server';
import { createPost, resolveGhlLocationId } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { summary, accountIds, scheduleDate, media } = body;
    const locationId = body.locationId || (await resolveGhlLocationId(session.accountId));
    if (!locationId || !summary) return badRequest('locationId (or configured account location) and summary required');
    const result = await createPost(locationId, summary, accountIds, scheduleDate, media);
    return NextResponse.json({ success: true, result }, { status: 201 });
  } catch (error: any) {
    return errorResponse(error);
  }
}
