import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function count(table: string, brandCol?: string, brandId?: string) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (brandCol && brandId) q = q.eq(brandCol, brandId);
  const { count: c } = await q;
  return c || 0;
}

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    const [leads, posts, campaigns] = await Promise.all([
      count('contacts', 'brand_id', brandId),
      count('content_calendar', 'brand_id', brandId),
      count('ad_campaigns', 'brand_id', brandId),
    ]);
    const { data: scored } = await supabase.from('contacts').select('score').eq('brand_id', brandId).eq('account_id', session.accountId);
    const avgScore = scored && scored.length
      ? Math.round(scored.reduce((s, r: any) => s + (r.score || 0), 0) / scored.length)
      : 0;
    // email_campaigns has no brand/account column; scope through the owning contact.
    const { count: emails } = await supabase
      .from('email_campaigns')
      .select('id, contacts!inner(brand_id)', { count: 'exact', head: true })
      .eq('contacts.brand_id', brandId);
    return NextResponse.json({ leads, avgScore, emails: emails || 0, posts, campaigns });
  } catch (error) {
    return errorResponse(error);
  }
}
