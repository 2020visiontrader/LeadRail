import { NextRequest, NextResponse } from 'next/server';
import { partnersRepo } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['name','type','contact_email','status','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const updates = pick(await request.json());
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    return NextResponse.json(await partnersRepo.update(params.id, updates, session.accountId));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await partnersRepo.remove(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
