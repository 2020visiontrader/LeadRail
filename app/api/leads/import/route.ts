import { NextRequest, NextResponse } from 'next/server';
import { supabase, findContactByEmail } from '@/lib/db';
import { parseUpload, fromCsv } from '@/lib/io';
import { scoreContact } from '@/lib/scoring';
import { writeAudit } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const MAP = ['name','email','company','title','segment','status','notes','phone','linkedin_url'];
// Accepts multipart (file=) OR JSON { brand_id, account_id, csv | rows }. Dedupes by email.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const ct = request.headers.get('content-type') || '';
    let rows: any[] = [];
    let brandId = request.nextUrl.searchParams.get('brandId') || '';
    let accountId = request.nextUrl.searchParams.get('accountId') || '';
    if (ct.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file') as File | null;
      brandId = (form.get('brand_id') as string) || brandId;
      accountId = (form.get('account_id') as string) || accountId;
      if (!file) return badRequest('file is required');
      rows = parseUpload(Buffer.from(await file.arrayBuffer()), file.name, file.type);
    } else {
      const body = await request.json();
      brandId = body.brand_id || brandId; accountId = body.account_id || accountId;
      rows = Array.isArray(body.rows) ? body.rows : typeof body.csv === 'string' ? fromCsv(body.csv) : [];
    }
    if (!brandId) return badRequest('brand_id is required');
    if (!rows.length) return badRequest('no rows parsed');

    let inserted = 0, skipped = 0; const errors: string[] = [];
    for (const raw of rows) {
      const r: any = {};
      for (const k of MAP) if (raw[k] !== undefined && raw[k] !== '') r[k] = raw[k];
      if (!r.email || !r.name) { skipped++; continue; }
      const existing = await findContactByEmail(r.email);
      if (existing) { skipped++; continue; }
      r.brand_id = brandId;
      if (accountId) r.account_id = accountId;
      r.source = 'import';
      r.score = scoreContact(r.segment || 'other', r.title || '', 0);
      const { error } = await supabase.from('contacts').insert([r]);
      if (error) { errors.push(`${r.email}: ${error.message}`); skipped++; } else inserted++;
    }
    if (accountId) await writeAudit({ account_id: accountId, brand_id: brandId, action: 'import', entity_type: 'contact', detail: { inserted, skipped, source: 'file' } });
    return NextResponse.json({ inserted, skipped, total: rows.length, errors: errors.slice(0, 10) });
  } catch (error) { return errorResponse(error); }
}
