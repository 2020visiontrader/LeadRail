import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json().catch(() => ({}));
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if ('url' in body) {
      if (!/^https:\/\//i.test(body.url)) return badRequest('https url required');
      patch.url = body.url;
    }
    if ('events' in body) patch.events = Array.isArray(body.events) ? body.events : [];
    if ('is_active' in body) patch.is_active = !!body.is_active;
    const { data, error: e } = await supabase
      .from('webhook_endpoints').update(patch)
      .eq('id', ctx.params.id).eq('account_id', session.accountId)
      .select('id, url, events, is_active, last_status, last_delivery_at').maybeSingle();
    if (e) throw e;
    if (!data) return badRequest('not found');
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const { data, error: e } = await supabase
      .from('webhook_endpoints').delete()
      .eq('id', ctx.params.id).eq('account_id', session.accountId).select('id');
    if (e) throw e;
    if (!data?.length) return badRequest('not found');
    return NextResponse.json({ id: ctx.params.id, deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
