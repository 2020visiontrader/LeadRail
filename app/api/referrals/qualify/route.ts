import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { qualifyReferral } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST { referredAccountId } — the QUALIFYING-EVENT hook. Call this from the
// billing/first-paid-conversion path (bearer-protected, machine-to-machine) to
// unlock the double-sided reward ledger with its hold window.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  let referredAccountId: string | undefined;
  try { referredAccountId = (await request.json())?.referredAccountId; } catch { /* */ }
  if (!referredAccountId) return badRequest('referredAccountId is required');
  try {
    return NextResponse.json(await qualifyReferral(referredAccountId));
  } catch (e) { return errorResponse(e); }
}
