import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { toCsv, toXlsx } from '@/lib/io';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const COLS = ['name','email','company','title','segment','score','status','source','fit_verdict','phone','linkedin_url','notes','created_at'];
async function GET__impl(request: NextRequest) {
  // Auth + tenant scoping: an export must be for a brand the caller owns, and
  // the query is pinned to the session account_id — never a client-guessed brand.
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  const segment = request.nextUrl.searchParams.get('segment') || '';
  const format = (request.nextUrl.searchParams.get('format') || 'csv').toLowerCase();
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    let q = supabase
      .from('contacts')
      .select(COLS.join(','))
      .eq('brand_id', brandId)
      .eq('account_id', session.accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (segment) q = q.eq('segment', segment);
    const { data, error: qErr } = await q;
    if (qErr) throw qErr;
    const rows = (data ?? []) as any[];
    const stamp = `${brandId}-leads${segment ? `-${segment}` : ''}`;
    if (format === 'xlsx') {
      const buf = toXlsx(rows, 'Leads');
      return new NextResponse(new Uint8Array(buf), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${stamp}.xlsx"` } });
    }
    return new NextResponse(toCsv(rows, COLS), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stamp}.csv"` } });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/leads/export", method: "GET" });
