import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { refineTemplate } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';

export const dynamic = 'force-dynamic';

// AI-refine (or draft) a message template from a plain-language instruction.
export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const instruction = String(body?.instruction || '').trim();
  if (!instruction) return badRequest('instruction is required');
  try {
    const result = await refineTemplate({
      instruction,
      current: body?.current || {},
      venture: body?.venture || {},
    });
    return NextResponse.json({ template: result });
  } catch (e: any) {
    if (e?.code === 'auth') return NextResponse.json({ error: 'opencode_auth_failed' }, { status: 502 });
    return errorResponse(e);
  }
}
