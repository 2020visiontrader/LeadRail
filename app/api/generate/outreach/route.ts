import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { generateOutreach } from '@/lib/ai/generation';
import { geminiConfigured } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

// POST /api/generate/outreach  (admin/account-scoped, on-demand only)
// body: { venture: {name, pitch?}, contact?: {...}, goal, tone?, framework? }
// Returns a draft { subject, body }. Does NOT send or persist anything.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!geminiConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'gemini' }, { status: 409 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  if (!body?.venture?.name) return badRequest('venture.name is required');
  if (!body?.goal) return badRequest('goal is required');

  try {
    const draft = await generateOutreach({
      contact: body.contact || {},
      venture: body.venture,
      goal: body.goal,
      tone: body.tone,
      framework: body.framework,
    });
    return NextResponse.json({ draft });
  } catch (error: any) {
    if (error?.code === 'not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    if (error?.code === 'auth') return NextResponse.json({ error: 'gemini_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}
