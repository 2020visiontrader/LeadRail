import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, getContact } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// email_campaigns predates multitenancy (no account_id); scope through the
// owning contact so a caller can only touch their own tenant's campaigns.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { data: campaign, error: cErr } = await supabase.from('email_campaigns').select('id, contact_id').eq('id', params.id).single();
    if (cErr || !campaign) return errorResponse(cErr, 404, 'Campaign not found');
    // Throws if the contact isn't in the caller's account -> becomes a 500/handled below.
    await getContact(campaign.contact_id, session.accountId);

    const body = await request.json();
    const patch: Record<string, any> = {};
    for (const k of ['status', 'subject', 'body', 'template_id']) if (body[k] != null) patch[k] = body[k];
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    const { data, error: uErr } = await supabase.from('email_campaigns').update(patch).eq('id', params.id).select();
    if (uErr) throw uErr;
    return NextResponse.json(data[0]);
  } catch (error) {
    return errorResponse(error, 404, 'Campaign not found');
  }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/outreach/[id]", method: "PATCH" });
