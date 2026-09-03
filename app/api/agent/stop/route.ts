import { withApi, requireSession, badRequest, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requestStop } from '@/lib/agent/memory';

export const dynamic = 'force-dynamic';
// No `runtime`/`maxDuration` overrides — matches the other cheap, single-write
// routes in this directory (e.g. app/api/agent/feedback/route.ts): this
// handler does one account-scoped UPDATE and returns, nothing here can
// legitimately run long, so the platform defaults are fine. Contrast with
// app/api/agent/route.ts and app/api/agent/stream/route.ts, which explicitly
// raise maxDuration because THEY run the model loop this route is asking to
// stop.

// POST /api/agent/stop — cooperative, server-side stop for a running turn
// (migration 083). Body: { conversationId }.
//
// This does NOT abort anything mid-flight — the agent loop (lib/agent/loop.ts)
// only checks the flag this sets BETWEEN steps, the same point it already
// checks its turn deadline, so a tool call already in progress always finishes
// before the turn honours the request. That is deliberate: a half-executed
// send is worse than a late one.
//
// Account scope is ALWAYS the session's, NEVER the request body — requestStop
// scopes its UPDATE on session.accountId, so a conversationId belonging to
// another account (or an unknown one) updates nothing and this route reports
// it exactly the same way it reports "no such conversation" for this account,
// never distinguishing the two (no existence oracle — same rule every other
// conversation-scoped route in this repo follows).
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }

  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;
  if (!conversationId) return badRequest('conversationId is required');

  try {
    const stopped = await requestStop(conversationId, session.accountId);
    return NextResponse.json({ ok: stopped });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/agent/stop', method: 'POST' });
