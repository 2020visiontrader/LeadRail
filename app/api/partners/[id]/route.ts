import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { partnersRepo } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['name','type','contact_email','status','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    return NextResponse.json(await partnersRepo.update(params.id, updates, session.accountId));
  } catch (error) { return errorResponse(error); }
}
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await partnersRepo.remove(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/partners/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/partners/[id]", method: "DELETE" });
