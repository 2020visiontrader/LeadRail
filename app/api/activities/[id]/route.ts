import { NextRequest, NextResponse } from 'next/server';
import { updateActivity, deleteActivity } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['type','subject','body','status','due_at','completed_at','contact_id','company_id','deal_id','owner_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateActivity(params.id, session.accountId, updates));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await deleteActivity(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
