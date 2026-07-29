import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    const { data, error } = await supabase
      .from('content_calendar').select('*').eq('brand_id', brandId)
      .order('scheduled_for', { ascending: true }).limit(limit);
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.brand_id || !body?.platform || !body?.post_body) {
      return NextResponse.json({ error: 'brand_id, platform, and post_body are required' }, { status: 400 });
    }
    if (!(await assertBrandOwned(body.brand_id, session.accountId))) return badRequest('unknown brand_id');
    const { data, error } = await supabase.from('content_calendar').insert([{
      brand_id: body.brand_id,
      account_id: session.accountId,
      platform: body.platform,
      post_body: body.post_body,
      media_urls: Array.isArray(body.media_urls) ? body.media_urls : null,
      scheduled_for: body.scheduled_for ?? null,
      status: body.status || 'draft',
    }]).select();
    if (error) throw error;
    return NextResponse.json(data[0], { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
