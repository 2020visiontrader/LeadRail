import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { toCsv, toXlsx } from '@/lib/io';
import { errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const COLS = ['platform','post_body','scheduled_for','status','media_urls','created_at'];
async function GET__impl(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const format = (request.nextUrl.searchParams.get('format') || 'csv').toLowerCase();
  if (!brandId) return badRequest('brandId is required');
  try {
    const { data, error } = await supabase.from('content_calendar').select(COLS.join(',')).eq('brand_id', brandId).order('scheduled_for', { ascending: true }).limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    const stamp = brandId + '-content';
    if (format === 'xlsx') {
      const buf = toXlsx(rows, 'Content');
      return new NextResponse(new Uint8Array(buf), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${stamp}.xlsx"` } });
    }
    return new NextResponse(toCsv(rows, COLS), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stamp}.csv"` } });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/content/export", method: "GET" });
