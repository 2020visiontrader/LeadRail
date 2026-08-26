import { withApi, requireSession, badRequest, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { grantStandingApproval, listGrants, revokeGrant, DEFAULT_GRANT_USES, DEFAULT_GRANT_MINUTES } from '@/lib/approvals/grants';
import { CAPABILITY_BY_NAME } from '@/lib/capabilities/registry';
import { grantableGate } from '@/lib/agent/loop';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Standing approvals — the "allow for this chat" tier.
//
// A grant is created ONLY from a request carrying a conversation id, and stored
// against it. There is deliberately no account-wide option: "yes, reveal these
// leads" must not license a reveal in a chat opened next week, and an endpoint
// that cannot express that cannot be talked into it later.

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }

  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
  if (!tool) return badRequest('tool is required');
  if (!conversationId) return badRequest('conversationId is required — a grant belongs to the chat it was given in');

  // The gate is read from the SERVER's registry, never from the request. A
  // client naming its own gate class could grant itself standing approval over
  // a destructive tool by asking nicely.
  const cap = CAPABILITY_BY_NAME[tool];
  if (!cap) return badRequest('Unknown action');
  if (!grantableGate(cap.gate)) {
    return NextResponse.json(
      { error: 'This action is asked every time and cannot be pre-approved.' },
      { status: 400 },
    );
  }

  try {
    const grant = await grantStandingApproval({
      accountId: session.accountId,
      conversationId,
      tool,
      grantedBy: session.email,
      // Bounds are the SERVER's, not the caller's. A client-supplied size is a
      // client-supplied blank cheque.
      uses: DEFAULT_GRANT_USES,
      minutes: DEFAULT_GRANT_MINUTES,
    });
    if (!grant) return NextResponse.json({ error: 'Could not record that permission.' }, { status: 500 });
    return NextResponse.json({ grant });
  } catch (e) {
    return errorResponse(e);
  }
}

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const conversationId = new URL(request.url).searchParams.get('conversationId') || '';
  if (!conversationId) return badRequest('conversationId is required');
  try {
    return NextResponse.json({ grants: await listGrants(session.accountId, conversationId) });
  } catch (e) {
    return errorResponse(e);
  }
}

async function DELETE__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return badRequest('id is required');
  try {
    await revokeGrant(session.accountId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/approvals/grants', method: 'POST' });
export const GET = withApi(GET__impl as any, { route: '/api/approvals/grants', method: 'GET' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/approvals/grants', method: 'DELETE' });
