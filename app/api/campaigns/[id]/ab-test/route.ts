import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAbReport, AbGuardError } from '@/lib/campaigns/analytics';

export const dynamic = 'force-dynamic';

// GET /api/campaigns/[id]/ab-test — live A/B analysis for one campaign.
// Returns per-creative performance + a plain-language iterate recommendation.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const report = await getCampaignAbReport(session.accountId, params.id);
    return NextResponse.json(report);
  } catch (e) {
    if (e instanceof AbGuardError) return NextResponse.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/campaigns/[id]/ab-test', method: 'GET' });
