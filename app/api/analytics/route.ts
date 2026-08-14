import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';
import { getTotals, getEventCountsByType, getEventTimeseries } from '@/lib/analytics/store';

export const dynamic = 'force-dynamic';

// GET /api/analytics?days=30 — { totals, byType, timeseries } for this account.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) {
    return NextResponse.json({ totals: { contacts: 0, events: 0, events7d: 0 }, byType: [], timeseries: [] });
  }
  try {
    const daysParam = Number(request.nextUrl.searchParams.get('days'));
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 30;
    const [totals, byType, timeseries] = await Promise.all([
      getTotals(session.accountId),
      getEventCountsByType(session.accountId, days),
      getEventTimeseries(session.accountId, days),
    ]);
    return NextResponse.json({ totals, byType, timeseries });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/analytics', method: 'GET' });
