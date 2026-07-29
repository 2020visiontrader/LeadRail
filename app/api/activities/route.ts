import { NextRequest, NextResponse } from 'next/server';
import { getActivities, createActivity } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['account_id','brand_id','type','subject','body','status','due_at','contact_id','company_id','deal_id','owner_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const accountId = p.get('accountId');
  if (!accountId) return badRequest('accountId is required');
  try {
    return NextResponse.json(await getActivities(accountId, {
      contactId: p.get('contactId') || undefined,
      dealId: p.get('dealId') || undefined,
      companyId: p.get('companyId') || undefined,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = pick(await request.json());
    if (!body.account_id) return badRequest('account_id is required');
    if (!body.type) return badRequest('type is required');
    return NextResponse.json(await createActivity(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
