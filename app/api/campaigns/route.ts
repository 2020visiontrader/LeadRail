import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// List ad campaigns for a brand.
export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  if (!brandId) return badRequest('brandId is required');
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

// Create an ad campaign.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    if (!body?.brand_id || !body?.name) {
      return NextResponse.json({ error: 'brand_id and name are required' }, { status: 400 });
    }
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
