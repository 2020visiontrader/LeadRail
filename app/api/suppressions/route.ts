import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { addSuppression } from '@/lib/suppressions';

export const dynamic = 'force-dynamic';

// Admin-facing suppression list management. Always scoped to the caller's account.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    if (!dbReady()) return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
    const { data, error: dbErr } = await supabase
      .from('suppressions')
      .select('*')
      .eq('account_id', session.accountId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (dbErr) throw dbErr;
    return NextResponse.json({ suppressions: data || [] });
  } catch (e) {
    return errorResponse(e);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const email = body?.email ? String(body.email) : undefined;
    const domain = body?.domain ? String(body.domain) : undefined;
    if (!email && !domain) return badRequest('email or domain is required');
    await addSuppression({ accountId: session.accountId, email, domain, reason: body?.reason || 'manual', source: 'manual' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

async function DELETE__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const id = request.nextUrl.searchParams.get('id');
    const email = request.nextUrl.searchParams.get('email');
    if (!id && !email) return badRequest('id or email is required');
    let q = supabase.from('suppressions').delete().eq('account_id', session.accountId);
    q = id ? q.eq('id', id) : q.eq('email', String(email).toLowerCase());
    const { error: dbErr } = await q;
    if (dbErr) throw dbErr;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/suppressions", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/suppressions", method: "POST" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/suppressions", method: "DELETE" });
