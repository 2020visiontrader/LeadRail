import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { updateActivity, deleteActivity } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['type','subject','body','status','due_at','completed_at','contact_id','company_id','deal_id','owner_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateActivity(params.id, session.accountId, updates));
  } catch (error) { return errorResponse(error); }
}

async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await deleteActivity(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/activities/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/activities/[id]", method: "DELETE" });
