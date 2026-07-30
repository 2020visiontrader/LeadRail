import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { generateOutreach } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { error: authErr } = await requireSession(request);
  if (authErr) return authErr;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
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
    if (error?.code === 'auth') return NextResponse.json({ error: 'opencode_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}
