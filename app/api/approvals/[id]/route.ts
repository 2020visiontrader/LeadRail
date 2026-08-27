import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getApproval, decideApproval, ApprovalDecisionError } from '@/lib/approvals/store';
import { createGrant, isGrantable, MAX_GRANT_USES } from '@/lib/approvals/grants';
import { capabilityFor } from '@/lib/agent/tools';
import { resumeStepForApproval } from '@/lib/plans/store';

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
// Body: { decision: 'approved' | 'rejected', comment?: string, args?: object,
//          scope?: 'once' | 'session', uses?: number }
//
// `scope: 'session'` is the third answer (migration 062): approve THIS call and
// stop asking for this tool, in this conversation, for the next `uses` calls.
// It never widens WHAT is allowed — only who is asked. The per-call decision
// happens first and stands on its own, so a failed grant still leaves it.
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

    // A plan step parked on this approval becomes runnable again. Best-effort
    // and keyed on approval_id, so the plan resumes at the step that was
    // waiting rather than restarting and redoing paid-for work.
    if (decision === 'approved') {
      void resumeStepForApproval(session.accountId, params.id).catch(() => {});
    }

    // Created only AFTER the per-call approval succeeded, and only for gates
    // where being asked per item is friction rather than a safeguard.
    let standing: { tool: string; uses: number; expiresAt: string } | null = null;
    let note: string | undefined;
    if (decision === 'approved' && String(body?.scope || 'once') === 'session') {
      const gate = capabilityFor(approval.tool)?.gate;
      if (!isGrantable(gate)) {
        note = 'This action always asks each time.';
      } else if (!approval.conversation_id) {
        // Without a conversation a grant cannot be session-scoped, and an
        // unscoped standing permission is what this must never create.
        note = 'This approval is not attached to a chat, so it cannot be made standing.';
      } else {
        const requested = Number(body?.uses);
        const { grant, clampedTo } = await createGrant({
          accountId: session.accountId,
          conversationId: approval.conversation_id,
          tool: approval.tool,
          uses: Number.isFinite(requested) && requested > 0 ? requested : MAX_GRANT_USES,
          grantedBy: session.email,
        });
        if (grant) {
          standing = { tool: grant.tool, uses: grant.usesRemaining, expiresAt: grant.expiresAt };
          if (clampedTo) note = `Capped at ${clampedTo} uses.`;
        } else {
          note = 'Could not record the standing approval, so this action will keep asking.';
        }
      }
    }
    return NextResponse.json({ ...approval, standing, standingNote: note });
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
