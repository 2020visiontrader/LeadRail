import { NextRequest, NextResponse } from 'next/server';
import { getDeal, updateDeal, deleteDeal } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','company_id','primary_contact_id','stage_id','name','amount','currency','status','probability','expected_close_date','source','owner_email','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getDeal(params.id, session.accountId)); }
  catch (error) { return errorResponse(error, 404, 'Deal not found'); }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateDeal(params.id, session.accountId, updates));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await deleteDeal(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
