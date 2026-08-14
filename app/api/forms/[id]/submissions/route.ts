import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { listSubmissions } from '@/lib/forms/store';

export const dynamic = 'force-dynamic';

// GET /api/forms/:id/submissions — list submissions for one form (scoped by
// both account_id and form_id).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const submissions = await listSubmissions(session.accountId, params.id);
    return NextResponse.json({ submissions });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/forms/[id]/submissions', method: 'GET' });
