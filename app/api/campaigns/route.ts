import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { createCampaignRecord, GuardError } from '@/lib/campaigns/actions';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    const { data, error } = await supabase
      .from('ad_campaigns').select('*').eq('brand_id', brandId)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.brand_id || !body?.name) {
      return NextResponse.json({ error: 'brand_id and name are required' }, { status: 400 });
    }
    const row = await createCampaignRecord(session.accountId, {
      brandId: body.brand_id,
      name: body.name,
      channel: body.channel ?? undefined,
      budget: body.budget,
      objective: body.objective,
      metaAdAccountId: body.meta_ad_account_id,
      startDate: body.start_date ?? undefined,
      endDate: body.end_date ?? undefined,
      status: body.status,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    if (error instanceof GuardError) return NextResponse.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/campaigns", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/campaigns", method: "POST" });
