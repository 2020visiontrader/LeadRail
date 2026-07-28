import { NextRequest, NextResponse } from 'next/server';
import { searchPeople, apolloConfigured } from '@/lib/integrations/apollo';
import { logApolloSearch, dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import type { ApolloQuery } from '@/lib/types';

export const dynamic = 'force-dynamic';

// POST /api/leads/apollo/search
// body: { accountId, brandId, query: ApolloQuery }
// Runs an Apollo People Search and returns normalized candidates for preview.
// Does NOT persist contacts — the client selects, then calls /import.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;

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
  const { accountId, brandId } = body || {};
  const query: ApolloQuery = body?.query || {};
  if (!accountId || !brandId) return badRequest('accountId and brandId are required');
  if (!query.titles?.length && !query.industry && !query.keywords) {
    return badRequest('describe an ICP: provide at least industry, titles, or keywords');
  }

  try {
    const { candidates, total } = await searchPeople(query);
    // Best-effort audit log; never fail the search on log error.
    if (dbReady()) {
      logApolloSearch({ account_id: accountId, brand_id: brandId, query, result_count: candidates.length })
        .catch((e) => console.error('[apollo-log]', e?.message || e));
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
