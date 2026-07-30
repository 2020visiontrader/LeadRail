import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { getReferralStats } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — the ambassador funnel (clicks -> signups -> qualified -> earnings).
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await getReferralStats(session.accountId));
  } catch (e) { return errorResponse(e); }
}
