import { NextRequest, NextResponse } from 'next/server';
import { partnersRepo } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['account_id','brand_id','name','type','contact_email','status','notes'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!accountId) return badRequest('accountId is required');
  try { return NextResponse.json(await partnersRepo.list(accountId, brandId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = pick(await request.json());
    if (!body.account_id) return badRequest('account_id is required');
    return NextResponse.json(await partnersRepo.create(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
