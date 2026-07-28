import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { data, error } = await supabase.from('ad_campaigns').select('*').eq('id', params.id).single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error, 404, 'Campaign not found');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    const patch: Record<string, any> = {};
    for (const k of ['name', 'channel', 'budget', 'spend', 'start_date', 'end_date', 'status']) if (body[k] != null) patch[k] = body[k];
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    const { data, error } = await supabase.from('ad_campaigns').update(patch).eq('id', params.id).select();
    if (error) throw error;
    return NextResponse.json(data[0]);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', params.id);
    if (error) throw error;
    return NextResponse.json({ id: params.id, deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
