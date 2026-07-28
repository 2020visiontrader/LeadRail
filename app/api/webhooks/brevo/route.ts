import { NextRequest, NextResponse } from 'next/server';
import { handleBrevoWebhook } from '@/lib/integrations/brevo';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Brevo has no HMAC by default; verify with a shared token appended to the URL
// (configure the endpoint as .../webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>).
export async function POST(request: NextRequest) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (secret && request.nextUrl.searchParams.get('token') !== secret) {
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
