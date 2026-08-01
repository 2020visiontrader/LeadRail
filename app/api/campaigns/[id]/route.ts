import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// ad_campaigns is brand-scoped; verify the campaign's brand belongs to the caller.
async function ownedCampaign(id: string, accountId: string) {
  const { data } = await supabase.from('ad_campaigns').select('id, brand_id').eq('id', id).single();
  if (!data || !(await assertBrandOwned(data.brand_id, accountId))) return null;
  return data;
}

async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    if (!(await ownedCampaign(params.id, session.accountId))) return errorResponse(null, 404, 'Campaign not found');
    const { data, error: e } = await supabase.from('ad_campaigns').select('*').eq('id', params.id).single();
    if (e) throw e;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error, 404, 'Campaign not found');
  }
}

async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    if (!(await ownedCampaign(params.id, session.accountId))) return errorResponse(null, 404, 'Campaign not found');
    const body = await request.json();
    const patch: Record<string, any> = {};
    for (const k of ['name', 'channel', 'budget', 'spend', 'start_date', 'end_date', 'status']) if (body[k] != null) patch[k] = body[k];
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    const { data, error: e } = await supabase.from('ad_campaigns').update(patch).eq('id', params.id).select();
    if (e) throw e;
    return NextResponse.json(data[0]);
  } catch (error) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    if (!(await ownedCampaign(params.id, session.accountId))) return errorResponse(null, 404, 'Campaign not found');
    const { error: e } = await supabase.from('ad_campaigns').delete().eq('id', params.id);
    if (e) throw e;
    return NextResponse.json({ id: params.id, deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/campaigns/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/campaigns/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/campaigns/[id]", method: "DELETE" });
