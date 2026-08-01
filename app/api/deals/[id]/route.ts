import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getDeal, updateDeal, deleteDeal } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','company_id','primary_contact_id','stage_id','name','amount','currency','status','probability','expected_close_date','source','owner_email','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getDeal(params.id, session.accountId)); }
  catch (error) { return errorResponse(error, 404, 'Deal not found'); }
}

async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateDeal(params.id, session.accountId, updates));
  } catch (error) { return errorResponse(error); }
}

async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await deleteDeal(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/deals/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/deals/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/deals/[id]", method: "DELETE" });
