import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { handleBrevoWebhook } from '@/lib/integrations/brevo';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Brevo has no HMAC by default; verify with a shared token appended to the URL
// (configure the endpoint as .../webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>).
async function POST__impl(request: NextRequest) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  } else if (request.nextUrl.searchParams.get('token') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const event = await request.json();
    await handleBrevoWebhook(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/webhooks/brevo", method: "POST" });
