import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { launchCampaign, GuardError } from '@/lib/campaigns/actions';

export const dynamic = 'force-dynamic';

// The ONLY endpoint that spends money. requireSession + ownership + budget +
// asset guards enforced inside launchCampaign(). Auto-audit-logged via withApi.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    const result = await launchCampaign(session.accountId, params.id, {
      message: body?.message, link: body?.link, dailyBudget: body?.daily_budget,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof GuardError) return NextResponse.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/campaigns/[id]/launch', method: 'POST' });
