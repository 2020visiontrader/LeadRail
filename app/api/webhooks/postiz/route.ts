import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { handlePostizWebhook } from '@/lib/integrations/postiz';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest) {
  const secret = process.env.POSTIZ_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  } else if (request.headers.get('x-postiz-secret') !== secret) {
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

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/webhooks/postiz", method: "POST" });
