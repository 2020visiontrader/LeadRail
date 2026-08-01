import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, getContact } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// List email campaigns (optionally by contactId), scoped to the caller's account
// via the owning contact (email_campaigns has no account_id of its own).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const contactId = request.nextUrl.searchParams.get('contactId');
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  try {
    let q = supabase
      .from('email_campaigns')
      .select('*, contacts!inner(account_id)')
      .eq('contacts.account_id', session.accountId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (contactId) q = q.eq('contact_id', contactId);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.contact_id) return NextResponse.json({ error: 'contact_id is required' }, { status: 400 });
    // Assert the contact belongs to the caller's account.
    await getContact(body.contact_id, session.accountId);
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

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/outreach", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/outreach", method: "POST" });
