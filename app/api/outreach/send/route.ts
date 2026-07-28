import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, errorResponse } from '@/lib/http';
import { sendOutreachEmail } from '@/lib/outreach';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    if (!body?.contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 });
    if (!body?.subject) return NextResponse.json({ error: 'subject is required' }, { status: 400 });
    const result = await sendOutreachEmail({
      contactId: body.contactId,
      subject: body.subject,
      html: body.html,
      templateId: body.templateId,
    });
    return NextResponse.json({ sent: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
