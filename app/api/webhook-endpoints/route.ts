import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { supabase, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// List the account's outbound webhook endpoints (secret redacted).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    const { data, error: e } = await supabase
      .from('webhook_endpoints')
      .select('id, url, events, is_active, last_status, last_delivery_at, created_at')
      .eq('account_id', session.accountId)
      .order('created_at', { ascending: false });
    if (e) throw e;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

// Register a new endpoint. The signing secret is generated server-side and
// returned ONCE in this response — it is redacted on every subsequent read.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.url || !/^https:\/\//i.test(body.url)) return badRequest('https url required');
    const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    const { data, error: e } = await supabase.from('webhook_endpoints').insert([{
      account_id: session.accountId,
      url: body.url,
      secret,
      events: Array.isArray(body.events) ? body.events : [],
      is_active: body.is_active ?? true,
    }]).select('id, url, events, is_active, created_at').single();
    if (e) throw e;
    return NextResponse.json({ ...data, secret }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/webhook-endpoints", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/webhook-endpoints", method: "POST" });
