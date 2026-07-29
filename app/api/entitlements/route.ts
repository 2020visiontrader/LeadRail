import { NextRequest, NextResponse } from 'next/server';
import { getEntitlements, createEntitlement } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['company_id','plan','sla_tier','seats','starts_at','ends_at'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const companyId = request.nextUrl.searchParams.get('companyId') || undefined;
  try { return NextResponse.json(await getEntitlements(session.accountId, companyId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body: any = pick(await request.json());
    body.account_id = session.accountId;
    return NextResponse.json(await createEntitlement(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
