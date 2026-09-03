import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { errorResponse, requireSession } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  // Tenant scoping: the query is pinned to the session's account_id — this
  // previously had no session read at all, so any authenticated caller could
  // list every tenant's active brands.
  const { session, error: authError } = await requireSession(request);
  if (authError) return authError;
  try {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .eq('active', true)
      .eq('account_id', session.accountId)
      .order('name');
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/brands", method: "GET" });
