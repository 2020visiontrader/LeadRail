import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady } from '@/lib/db';

export const dynamic = 'force-dynamic';

// PATCH — switch a rule on or off, or adjust its daily limit.
//
// Only these two fields. Changing what a rule DOES while it is armed would let
// a rule someone approved as "notify me" quietly become "reply publicly" —
// so editing behaviour means deleting and recreating, which lands it back in
// the disabled state where it has to be armed again on purpose.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const b = await request.json();
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if (typeof b?.enabled === 'boolean') patch.enabled = b.enabled;
    if (b?.dailyCap !== undefined) {
      const cap = Number(b.dailyCap);
      if (!Number.isFinite(cap) || cap < 1 || cap > 200) return badRequest('the daily limit must be between 1 and 200');
      patch.daily_cap = cap;
    }
    const { data, error: e } = await supabase
      .from('social_automations').update(patch)
      .eq('id', params.id).eq('account_id', session.accountId)
      .select('*').single();
    if (e) throw e;
    return NextResponse.json({ automation: data });
  } catch (e) {
    return errorResponse(e);
  }
}

async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { error: e } = await supabase
      .from('social_automations').delete()
      .eq('id', params.id).eq('account_id', session.accountId);
    if (e) throw e;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PATCH = withApi(PATCH__impl as any, { route: '/api/social-automations/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/social-automations/[id]', method: 'DELETE' });
