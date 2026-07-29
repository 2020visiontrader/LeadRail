import { NextRequest, NextResponse } from 'next/server';
import { casesRepo } from '@/lib/crm';
import { requireAuth, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['subject','description','status','priority','assigned_to','company_id','contact_id'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const b = await request.json();
    const updates = pick(b);
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
    return NextResponse.json(await casesRepo.update(params.id, updates, b.accountId));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try { return NextResponse.json(await casesRepo.remove(params.id, request.nextUrl.searchParams.get('accountId') || undefined)); }
  catch (error) { return errorResponse(error); }
}
