import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    const patch: Record<string, any> = {};
    for (const k of ['status', 'subject', 'body', 'template_id']) if (body[k] != null) patch[k] = body[k];
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    const { data, error } = await supabase.from('email_campaigns').update(patch).eq('id', params.id).select();
    if (error) throw error;
    return NextResponse.json(data[0]);
  } catch (error) {
    return errorResponse(error);
  }
}
