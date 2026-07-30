import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { parseIcpFromText } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';

export const dynamic = 'force-dynamic';

// Plain-language → structured Apollo ICP. The user describes who they want in
// one sentence; the returned object fills the search form so they never have to
// hand-tune keyword/seniority/company-size fields.
export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const text = String(body?.text || '').trim();
  if (!text) return badRequest('text is required');
  try {
    const icp = await parseIcpFromText(text);
    return NextResponse.json({ icp });
  } catch (e: any) {
    if (e?.code === 'auth') return NextResponse.json({ error: 'opencode_auth_failed' }, { status: 502 });
    return errorResponse(e);
  }
}
