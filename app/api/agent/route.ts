import { withApi, requireSession, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgent, agentConfigured } from '@/lib/agent/loop';
import type { ChatMessage } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// POST /api/agent — LeadRail AI conversational executor.
// Body: { message?, brandId?, transcript?, approve?: { tool, args } }
//  - message:    a new user instruction (start or continue a conversation)
//  - approve:    execute a previously-proposed sensitive tool, then continue
//  - transcript: prior model transcript returned by a needs_approval result
// Account scope is ALWAYS the authenticated session — never the request body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!agentConfigured()) {
    return NextResponse.json(
      { error: 'LeadRail AI is temporarily unavailable', code: 'not_configured' },
      { status: 409 },
    );
  }

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }

  const message: string | undefined = typeof body?.message === 'string' ? body.message : undefined;
  const approve = body?.approve && typeof body.approve === 'object' && typeof body.approve.tool === 'string'
    ? { tool: body.approve.tool as string, args: (body.approve.args && typeof body.approve.args === 'object') ? body.approve.args : {} }
    : undefined;
  if (!message && !approve) return badRequest('provide a message or an approved action');

  const transcript: ChatMessage[] = Array.isArray(body?.transcript)
    ? body.transcript.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  // Resolve a venture name for prompt context (best-effort; ownership is still
  // enforced per-tool). Only names for brands the session owns.
  let brandName: string | undefined;
  if (typeof body?.brandId === 'string' && body.brandId) {
    const { data } = await supabase.from('brands')
      .select('name').eq('id', body.brandId).eq('account_id', session.accountId).maybeSingle();
    if (data?.name) brandName = data.name;
  }

  const result = await runAgent({
    accountId: session.accountId,
    message,
    approve,
    transcript,
    brandContext: brandName ? { name: brandName } : undefined,
  });

  return NextResponse.json({
    status: result.status,
    message: result.message,
    proposal: result.proposal,
    steps: result.steps,
    transcript: result.transcript,
  });
}

export const POST = withApi(POST__impl as any, { route: '/api/agent', method: 'POST' });
