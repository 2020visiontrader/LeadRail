import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { validateModels, affordableModels } from '@/lib/ai/validate-models';

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

  // ?maxIn=&maxOut= (USD per million tokens) switches this from "are the
  // configured ids still real" to "what else could go in the chain at this
  // price". Same catalogue request either way; the caller decides the question.
  const url = new URL(request.url);
  const maxIn = numParam(url.searchParams.get('maxIn'));
  const maxOut = numParam(url.searchParams.get('maxOut'));

  try {
    if (maxIn !== null || maxOut !== null) {
      const { models, catalogueReachable } = await affordableModels({
        // A ceiling the caller did not set is not a ceiling. Infinity rather
        // than a default number, so a one-sided query means what it says.
        maxInPerMTok: maxIn ?? Number.POSITIVE_INFINITY,
        maxOutPerMTok: maxOut ?? Number.POSITIVE_INFINITY,
        excludeFree: url.searchParams.get('excludeFree') === '1',
      });
      return NextResponse.json({
        catalogueReachable,
        ceilings: { maxInPerMTok: maxIn, maxOutPerMTok: maxOut },
        count: models.length,
        // Prices come back with the ids so the answer can be checked against
        // the provider rather than taken on faith.
        models,
      });
    }

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

/** A price ceiling, or null when absent or unparseable. Zero is a valid
 *  ceiling (free only) and must survive. */
function numParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const GET = withApi(GET__impl as any, { route: '/api/admin/model-catalogue', method: 'GET' });
