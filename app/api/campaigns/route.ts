import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

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
    if (!(await assertBrandOwned(body.brand_id, session.accountId))) return badRequest('unknown brand_id');
    const { data, error } = await supabase.from('ad_campaigns').insert([{
      brand_id: body.brand_id,
      name: body.name,
      channel: body.channel ?? null,
      budget: Number(body.budget) || 0,
      start_date: body.start_date ?? null,
      end_date: body.end_date ?? null,
      status: body.status || 'draft',
    }]).select();
    if (error) throw error;
    return NextResponse.json(data[0], { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/campaigns", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/campaigns", method: "POST" });
