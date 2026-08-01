import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getChannels, getChannel } from '@/lib/social/buffer';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
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

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/buffer/channels", method: "GET" });
