import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { pauseCampaign, GuardError } from '@/lib/campaigns/actions';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const row = await pauseCampaign(session.accountId, params.id);
    return NextResponse.json({ ok: true, campaign: row });
  } catch (e) {
    if (e instanceof GuardError) return NextResponse.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/campaigns/[id]/pause', method: 'POST' });
