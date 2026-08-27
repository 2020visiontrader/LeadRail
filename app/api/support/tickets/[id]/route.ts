import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest, withApi } from '@/lib/http';
import { getTicket, moveTicket, type TicketStatus } from '@/lib/support/tickets';

export const dynamic = 'force-dynamic';

function guardRole(session: { role: string }) {
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

// GET /api/support/tickets/:id — one ticket plus its event history, for the
// board's detail view. Same owner/admin gate as the list route.
//
// getTicket is scoped to session.accountId and returns null both for an id
// that does not exist and for an id belonging to another tenant — the same
// "unknown ticket" 400 either way. That indistinguishability is deliberate,
// mirroring the comment on GET /api/agent/conversations/[id]: telling an
// owner "that ticket exists, you just can't see it" is itself a leak (an
// existence oracle for ids across every other tenant), so both cases must
// look identical from here.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const forbidden = guardRole(session);
  if (forbidden) return forbidden;
  try {
    const result = await getTicket(params.id, session.accountId);
    if (!result) return badRequest('unknown ticket');
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/support/tickets/:id — move a ticket between columns.
//
// The one thing this route must get right: a move made through this endpoint
// is always made by a signed-in HUMAN, because reaching it at all required
// passing the requireSession + owner/admin gate above. moveTicket's `isHuman`
// flag is what decides whether AGENT_ALLOWED applies — see the comment on
// that map in lib/support/tickets.ts: nothing leads to 'accepted' for a
// machine, on purpose. There is no request body flag that can set isHuman to
// false; this route always passes true, so a person using this endpoint is
// never held to the agent's narrower transition set. Whatever internal code
// path files/advances tickets as the agent (fileFailure, attachAssessment,
// and any agent-driven moveTicket call) is expected to call moveTicket
// directly with isHuman: false — that path does not run through this route.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const forbidden = guardRole(session);
  if (forbidden) return forbidden;
  try {
    const body = await request.json().catch(() => ({}));
    const to = body?.to as TicketStatus | undefined;
    if (!to) return badRequest('missing "to" status');
    const ticket = await moveTicket({
      id: params.id,
      to,
      actor: session.email,
      isHuman: true,
      note: typeof body?.note === 'string' ? body.note : undefined,
      resolution: typeof body?.resolution === 'string' ? body.resolution : undefined,
      // Scopes both the visibility check and the update itself to this
      // caller's tenant — see moveTicket's comment in lib/support/tickets.ts.
      // Without it a signed-in owner of account A could move account B's
      // tickets; session.role === 'owner' is per-account, not platform-wide.
      accountId: session.accountId,
    });
    return NextResponse.json({ ticket });
  } catch (err: any) {
    // moveTicket throws a plain Error with a human-readable message for a
    // disallowed transition or a missing ticket — surface that text rather
    // than the generic 500 errorResponse would give, since it is the reason
    // the UI needs to show the operator.
    if (err instanceof Error) return badRequest(err.message);
    return errorResponse(err);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/support/tickets/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/support/tickets/[id]', method: 'PATCH' });
