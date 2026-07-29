import { NextRequest, NextResponse } from 'next/server';
import { getCompanies, createCompany } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['account_id','brand_id','name','domain','website','industry','size','linkedin_url','location','description'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!accountId) return badRequest('accountId is required');
  try {
    return NextResponse.json(await getCompanies(accountId, brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = pick(await request.json());
    if (!body.account_id) return badRequest('account_id is required');
    if (!body.name) return badRequest('name is required');
    return NextResponse.json(await createCompany(body), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
