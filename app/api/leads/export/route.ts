import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { toCsv, toXlsx } from '@/lib/io';
import { errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const COLS = ['name','email','company','title','segment','score','status','source','fit_verdict','phone','linkedin_url','notes','created_at'];
export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const format = (request.nextUrl.searchParams.get('format') || 'csv').toLowerCase();
  if (!brandId) return badRequest('brandId is required');
  try {
    const { data, error } = await supabase.from('contacts').select(COLS.join(',')).eq('brand_id', brandId).order('created_at', { ascending: false }).limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    const stamp = brandId + '-leads';
    if (format === 'xlsx') {
      const buf = toXlsx(rows, 'Leads');
      return new NextResponse(new Uint8Array(buf), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${stamp}.xlsx"` } });
    }
    return new NextResponse(toCsv(rows, COLS), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stamp}.csv"` } });
  } catch (error) { return errorResponse(error); }
}
