import { NextRequest, NextResponse } from 'next/server';
import { getCompanies, createCompany } from '@/lib/crm';
import { assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','name','domain','website','industry','size','linkedin_url','location','description'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  try {
    return NextResponse.json(await getCompanies(session.accountId, brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body: any = pick(await request.json());
    if (!body.name) return badRequest('name is required');
    if (body.brand_id && !(await assertBrandOwned(body.brand_id, session.accountId))) return badRequest('unknown brand_id');
    body.account_id = session.accountId;
    return NextResponse.json(await createCompany(body), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
