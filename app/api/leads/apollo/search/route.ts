import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { searchPeople, apolloConfigured } from '@/lib/integrations/apollo';
import { logApolloSearch, dbReady, assertBrandOwned } from '@/lib/db';
import { recordIcpRun } from '@/lib/icp';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import type { ApolloQuery } from '@/lib/types';

export const dynamic = 'force-dynamic';

// POST /api/leads/apollo/search  body: { brandId, query: ApolloQuery }
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!apolloConfigured()) {
    return NextResponse.json(
      { error: 'Apollo is not connected', code: 'not_configured', connect: 'APOLLO_API_KEY' },
      { status: 409 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  const accountId = session.accountId;
  const { brandId } = body || {};
  const query: ApolloQuery = body?.query || {};
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, accountId))) return badRequest('unknown brandId');
  if (!query.titles?.length && !query.industry && !query.keywords) {
    return badRequest('describe an ICP: provide at least industry, titles, or keywords');
  }

  try {
    const { candidates, total } = await searchPeople(query);
    if (dbReady()) {
      logApolloSearch({ account_id: accountId, brand_id: brandId, query, result_count: candidates.length })
        .catch((e) => console.error('[apollo-log]', e?.message || e));
      // When the search was launched from a saved ICP, stamp the run onto it.
      if (body?.icpId) recordIcpRun(String(body.icpId), accountId, candidates.length);
    }
    return NextResponse.json({ candidates, total, returned: candidates.length });
  } catch (error: any) {
    if (error?.code === 'auth') return errorResponse(error, 401, 'Apollo rejected the API key');
    if (error?.code === 'not_configured') {
      return NextResponse.json({ error: 'Apollo is not connected', code: 'not_configured' }, { status: 409 });
    }
    return errorResponse(error, 502, 'Apollo search failed');
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/leads/apollo/search", method: "POST" });
