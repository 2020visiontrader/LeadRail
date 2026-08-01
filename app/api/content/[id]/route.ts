import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// content_calendar carries account_id; scope every mutation by it.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const patch: Record<string, any> = {};
    for (const k of ['post_body', 'platform', 'scheduled_for', 'status', 'media_urls']) if (body[k] != null) patch[k] = body[k];
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    const { data, error: e } = await supabase.from('content_calendar').update(patch).eq('id', params.id).eq('account_id', session.accountId).select();
    if (e) throw e;
    if (!data || !data.length) return errorResponse(null, 404, 'Post not found');
    return NextResponse.json(data[0]);
  } catch (error) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { data, error: e } = await supabase.from('content_calendar').delete().eq('id', params.id).eq('account_id', session.accountId).select('id');
    if (e) throw e;
    if (!data || !data.length) return errorResponse(null, 404, 'Post not found');
    return NextResponse.json({ id: params.id, deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/content/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/content/[id]", method: "DELETE" });
