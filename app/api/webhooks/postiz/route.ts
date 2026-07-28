import { NextRequest, NextResponse } from 'next/server';
import { handlePostizWebhook } from '@/lib/integrations/postiz';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = process.env.POSTIZ_WEBHOOK_SECRET;
  if (secret && request.headers.get('x-postiz-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const event = await request.json();
    await handlePostizWebhook(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}
