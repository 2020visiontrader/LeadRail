import { NextRequest, NextResponse } from 'next/server';
import { getDeals, createDeal } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['account_id','brand_id','company_id','primary_contact_id','stage_id','name','amount','currency','probability','expected_close_date','source','owner_email','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!accountId) return badRequest('accountId is required');
  try { return NextResponse.json(await getDeals(accountId, brandId)); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = pick(await request.json());
    if (!body.account_id) return badRequest('account_id is required');
    if (!body.name) return badRequest('name is required');
    return NextResponse.json(await createDeal(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
