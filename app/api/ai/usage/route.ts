import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { getAiUsageSummary } from '@/lib/credits';

export const dynamic = 'force-dynamic';

// GET /api/ai/usage?days=30 — per-model call/token summary for the Settings
// -> Models usage view. Defaults to a 30-day window.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const days = Number(request.nextUrl.searchParams.get('days')) || 30;
    const usage = await getAiUsageSummary(session.accountId, days);
    return NextResponse.json({ usage });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ai/usage", method: "GET" });
