import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getApproval, decideApproval, ApprovalDecisionError } from '@/lib/approvals/store';

export const dynamic = 'force-dynamic';

// GET /api/approvals/:id — fetch one approval (account-scoped). Never returns
// decrypted args.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const approval = await getApproval(session.accountId, params.id);
    if (!approval) return badRequest('unknown approval');
    return NextResponse.json(approval);
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/approvals/:id — decide a pending approval.
// Body: { decision: 'approved' | 'rejected', comment?: string, args?: object }
// `args`, when supplied, lets a caller re-assert the current proposed args so
// decideApproval can enforce edit-invalidation; omit it to decide against the
// stored args_hash as-is. No-self-approval and pending-only are enforced
// server-side inside lib/approvals/store.ts — never trust a client claim
// about who is deciding; decidedBy is always session.email.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const decision = String(body?.decision || '');
    if (decision !== 'approved' && decision !== 'rejected') {
      return badRequest('decision must be "approved" or "rejected"');
    }
    const comment = typeof body?.comment === 'string' ? body.comment.slice(0, 2000) : undefined;
    const currentArgs = body?.args && typeof body.args === 'object' ? body.args : undefined;
    const approval = await decideApproval(
      session.accountId,
      params.id,
      decision,
      { decidedBy: session.email, comment },
      currentArgs,
    );
    return NextResponse.json(approval);
  } catch (e: any) {
    if (e instanceof ApprovalDecisionError) {
      const status = e.code === 'not_found' ? 404 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/approvals/[id]', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/approvals/[id]', method: 'POST' });
