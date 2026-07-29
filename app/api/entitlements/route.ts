import { NextRequest, NextResponse } from 'next/server';
import { getEntitlements, createEntitlement } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['account_id','company_id','plan','sla_tier','seats','starts_at','ends_at'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  const companyId = request.nextUrl.searchParams.get('companyId') || undefined;
  if (!accountId) return badRequest('accountId is required');
  try { return NextResponse.json(await getEntitlements(accountId, companyId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = pick(await request.json());
    if (!body.account_id) return badRequest('account_id is required');
    return NextResponse.json(await createEntitlement(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
