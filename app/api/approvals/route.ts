import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listApprovals, type ApprovalState } from '@/lib/approvals/store';

export const dynamic = 'force-dynamic';

const VALID_STATES: ApprovalState[] = ['pending', 'approved', 'rejected', 'expired', 'invalidated'];

// GET /api/approvals?state=pending — list this account's durable approval
// proposals (migration 028_approvals.sql). Never returns decrypted args —
// only args_redacted + has_encrypted_args (see lib/approvals/store.ts).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ approvals: [] });
  try {
    const stateParam = request.nextUrl.searchParams.get('state');
    if (stateParam && !VALID_STATES.includes(stateParam as ApprovalState)) {
      return badRequest(`state must be one of: ${VALID_STATES.join(', ')}`);
    }
    const approvals = await listApprovals(session.accountId, stateParam ? { state: stateParam as ApprovalState } : undefined);
    return NextResponse.json({ approvals });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/approvals', method: 'GET' });
