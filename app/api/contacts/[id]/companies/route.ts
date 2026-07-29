import { NextRequest, NextResponse } from 'next/server';
import { getContactCompanyRoles, linkContactCompany } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(_r: NextRequest, { params }: { params: { id: string } }) {
  try { return NextResponse.json(await getContactCompanyRoles(params.id)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const { account_id, company_id, role, is_primary } = await request.json();
    if (!account_id || !company_id) return badRequest('account_id and company_id are required');
    return NextResponse.json(await linkContactCompany({ account_id, contact_id: params.id, company_id, role, is_primary }), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
