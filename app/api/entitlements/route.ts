import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getEntitlements, createEntitlement } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['company_id','plan','sla_tier','seats','starts_at','ends_at'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const companyId = request.nextUrl.searchParams.get('companyId') || undefined;
  try { return NextResponse.json(await getEntitlements(session.accountId, companyId)); }
  catch (error) { return errorResponse(error); }
}
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body: any = pick(await request.json());
    body.account_id = session.accountId;
    return NextResponse.json(await createEntitlement(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/entitlements", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/entitlements", method: "POST" });
