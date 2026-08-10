import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { syncCampaign, GuardError } from '@/lib/campaigns/actions';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const insights = await syncCampaign(session.accountId, params.id);
    return NextResponse.json({ ok: true, spend: insights.spend, insights });
  } catch (e) {
    if (e instanceof GuardError) return NextResponse.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/campaigns/[id]/sync', method: 'GET' });
