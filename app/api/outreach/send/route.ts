import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { sendOutreachEmail } from '@/lib/outreach';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 });
    if (!body?.subject) return NextResponse.json({ error: 'subject is required' }, { status: 400 });
    const result = await sendOutreachEmail({
      contactId: body.contactId,
      subject: body.subject,
      html: body.html,
      templateId: body.templateId,
      accountId: session.accountId,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
    });
    return NextResponse.json({ sent: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/outreach/send", method: "POST" });
