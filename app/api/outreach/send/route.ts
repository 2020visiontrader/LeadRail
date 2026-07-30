import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { sendOutreachEmail } from '@/lib/outreach';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
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
