import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { parseUpload, fromCsv } from '@/lib/io';
import { writeAudit } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const accountId = session.accountId;
  try {
    const ct = request.headers.get('content-type') || '';
    let rows: any[] = [];
    let brandId = request.nextUrl.searchParams.get('brandId') || '';
    if (ct.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file') as File | null;
      brandId = (form.get('brand_id') as string) || brandId;
      if (!file) return badRequest('file is required');
      rows = parseUpload(Buffer.from(await file.arrayBuffer()), file.name, file.type);
    } else {
      const body = await request.json();
      brandId = body.brand_id || brandId;
      rows = Array.isArray(body.rows) ? body.rows : typeof body.csv === 'string' ? fromCsv(body.csv) : [];
    }
    if (!brandId) return badRequest('brand_id is required');
    if (!(await assertBrandOwned(brandId, accountId))) return badRequest('unknown brand_id');
    if (!rows.length) return badRequest('no rows parsed');
    let inserted = 0, skipped = 0;
    for (const raw of rows) {
      if (!raw.platform || !raw.post_body) { skipped++; continue; }
      const media = raw.media_urls ? (Array.isArray(raw.media_urls) ? raw.media_urls : String(raw.media_urls).split('|').filter(Boolean)) : null;
      const row: any = { brand_id: brandId, account_id: accountId, platform: raw.platform, post_body: raw.post_body, status: raw.status || 'draft', scheduled_for: raw.scheduled_for || null, media_urls: media };
      const { error: insErr } = await supabase.from('content_calendar').insert([row]);
      if (insErr) skipped++; else inserted++;
    }
    await writeAudit({ account_id: accountId, brand_id: brandId, action: 'import', entity_type: 'content', detail: { inserted, skipped } });
    return NextResponse.json({ inserted, skipped, total: rows.length });
  } catch (error) { return errorResponse(error); }
}
