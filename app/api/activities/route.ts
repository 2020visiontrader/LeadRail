import { NextRequest, NextResponse } from 'next/server';
import { getActivities, createActivity } from '@/lib/crm';
import { assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','type','subject','body','status','due_at','contact_id','company_id','deal_id','owner_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const p = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await getActivities(session.accountId, {
      contactId: p.get('contactId') || undefined,
      dealId: p.get('dealId') || undefined,
      companyId: p.get('companyId') || undefined,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body: any = pick(await request.json());
    if (!body.type) return badRequest('type is required');
    if (body.brand_id && !(await assertBrandOwned(body.brand_id, session.accountId))) return badRequest('unknown brand_id');
    body.account_id = session.accountId;
    return NextResponse.json(await createActivity(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
