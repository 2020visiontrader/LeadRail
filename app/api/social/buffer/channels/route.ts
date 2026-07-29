import { NextRequest, NextResponse } from 'next/server';
import { getChannels, getChannel } from '@/lib/social/buffer';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const channelId = request.nextUrl.searchParams.get('channelId');
    if (channelId) {
      const channel = await getChannel(channelId);
      return NextResponse.json(channel);
    }
    const channels = await getChannels();
    return NextResponse.json(channels);
  } catch (error: any) {
    return errorResponse(error);
  }
}
