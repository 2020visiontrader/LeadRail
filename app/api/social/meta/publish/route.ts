import { NextRequest, NextResponse } from 'next/server';
import { publishToFacebookPage, publishToInstagramForAccount } from '@/lib/integrations/meta';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { platform, message, imageUrl, videoUrl, link } = body;
    const accountId = session.accountId;
    if (!platform) return badRequest('platform required');
    if (!message && !imageUrl && !videoUrl) return badRequest('message, imageUrl, or videoUrl required');

    if (platform === 'instagram') {
      if (!imageUrl && !videoUrl) return badRequest('Instagram posts require imageUrl or videoUrl');
      const result = await publishToInstagramForAccount(accountId, { caption: message || '', imageUrl, videoUrl });
      return NextResponse.json({ success: true, platform, result }, { status: 201 });
    }
    if (platform === 'facebook') {
      const result = await publishToFacebookPage(accountId, { message, link, imageUrl });
      return NextResponse.json({ success: true, platform, result }, { status: 201 });
    }
    return badRequest('platform must be "facebook" or "instagram"');
  } catch (error: any) {
    return errorResponse(error);
  }
}
