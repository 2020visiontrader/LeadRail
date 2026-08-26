import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { validateModels } from '@/lib/ai/validate-models';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// GET /api/admin/model-catalogue — does every configured id still exist?
//
// The sibling /api/admin/model-probe CALLS each model, which is authoritative
// but slow (it walks ~30 models against three providers) and conflates two very
// different failures: "this id is gone" and "this id is fine but the account is
// out of credit". Both surface as a red row.
//
// This is the cheap half. OpenRouter publishes its catalogue unauthenticated,
// so a single request separates a retired slug — which no amount of billing
// fixes and which needs a human to pick a replacement — from an account
// problem. Run it first; run the probe when this comes back clean and the tier
// is still dead.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Owners only' }, { status: 403 });
  }

  try {
    const { checks, catalogueReachable } = await validateModels(session.accountId);
    return NextResponse.json({
      catalogueReachable,
      missing: checks.filter((c) => c.status === 'missing'),
      checks,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/admin/model-catalogue', method: 'GET' });
