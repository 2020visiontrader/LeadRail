import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function count(table: string, brandCol?: string, brandId?: string) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (brandCol && brandId) q = q.eq(brandCol, brandId);
  const { count: c } = await q;
  return c || 0;
}

export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  try {
    const [leads, posts, campaigns] = await Promise.all([
      count('contacts', 'brand_id', brandId),
      count('content_calendar', 'brand_id', brandId),
      count('ad_campaigns', 'brand_id', brandId),
    ]);
    const { data: scored } = await supabase.from('contacts').select('score').eq('brand_id', brandId);
    const avgScore = scored && scored.length
      ? Math.round(scored.reduce((s, r: any) => s + (r.score || 0), 0) / scored.length)
      : 0;
    const emails = await count('email_campaigns');
    return NextResponse.json({ leads, avgScore, emails, posts, campaigns });
  } catch (error) {
    return errorResponse(error);
  }
}
