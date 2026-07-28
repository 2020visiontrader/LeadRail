import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// List email campaigns (optionally by contactId).
export async function GET(request: NextRequest) {
  const contactId = request.nextUrl.searchParams.get('contactId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  try {
    let q = supabase.from('email_campaigns').select('*').order('created_at', { ascending: false }).limit(limit);
    if (contactId) q = q.eq('contact_id', contactId);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

// Create a draft email campaign row.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    if (!body?.contact_id) return NextResponse.json({ error: 'contact_id is required' }, { status: 400 });
    const { data, error } = await supabase.from('email_campaigns').insert([{
      contact_id: body.contact_id,
      template_id: body.template_id ?? null,
      subject: body.subject ?? null,
      body: body.body ?? null,
      status: 'draft',
    }]).select();
    if (error) throw error;
    return NextResponse.json(data[0], { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
