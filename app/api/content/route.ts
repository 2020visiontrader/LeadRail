import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// List scheduled/draft content for a brand.
export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  if (!brandId) return badRequest('brandId is required');
  try {
    const { data, error } = await supabase
      .from('content_calendar')
      .select('*')
      .eq('brand_id', brandId)
      .order('scheduled_for', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

// Create a content_calendar entry.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    if (!body?.brand_id || !body?.platform || !body?.post_body) {
      return NextResponse.json({ error: 'brand_id, platform, and post_body are required' }, { status: 400 });
    }
    // Resolve account_id from the brand so the post is publishable (publish path
    // needs account_id to look up account-scoped Meta/Postiz tokens).
    let accountId = body.account_id ?? null;
    if (!accountId) {
      const { data: brand } = await supabase.from('brands').select('account_id').eq('id', body.brand_id).single();
      accountId = brand?.account_id ?? null;
    }
    const { data, error } = await supabase.from('content_calendar').insert([{
      brand_id: body.brand_id,
      account_id: accountId,
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
