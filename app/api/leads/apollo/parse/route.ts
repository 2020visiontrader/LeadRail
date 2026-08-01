import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { parseIcpFromText } from '@/lib/ai/generation';
import { textConfigured } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// Plain-language → structured Apollo ICP. The user describes who they want in
// one sentence; the returned object fills the search form so they never have to
// hand-tune keyword/seniority/company-size fields.
async function POST__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  if (!textConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'ai' }, { status: 409 });
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

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/leads/apollo/parse", method: "POST" });
