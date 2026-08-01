import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { generateOutreach } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';
import { getVenture, assertBrandOwned } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest) {
  const { session, error: authErr } = await requireSession(request);
  if (authErr) return authErr;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  if (!body?.goal) return badRequest('goal is required');

  // The venture (with its stored sender persona, pitch, and skills) is the
  // source of truth — load it server-side by id, account-scoped, so the client
  // can't spoof identity and the generator always sees the real profile. Falls
  // back to a bare {name} for callers that don't pass a ventureId.
  let venture: any = body.venture;
  if (body?.ventureId) {
    if (!(await assertBrandOwned(String(body.ventureId), session.accountId))) return badRequest('unknown venture');
    const v = await getVenture(String(body.ventureId));
    venture = {
      name: v.name,
      pitch: v.pitch || v.deck_summary || undefined,
      senderName: v.sender_name || undefined,
      senderRole: v.sender_role || undefined,
      signature: v.signature || undefined,
      defaultCta: v.default_cta || undefined,
      skills: Array.isArray(v.skills) ? v.skills : undefined,
    };
    if (!body.tone && v.tone) body.tone = v.tone;
  }
  if (!venture?.name) return badRequest('venture.name or ventureId is required');

  try {
    const draft = await generateOutreach({
      contact: body.contact || {},
      venture,
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

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/generate/outreach", method: "POST" });
