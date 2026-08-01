import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getContactCompanyRoles, linkContactCompany } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getContactCompanyRoles(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { company_id, role, is_primary } = await request.json();
    if (!company_id) return badRequest('company_id is required');
    return NextResponse.json(await linkContactCompany({ account_id: session.accountId, contact_id: params.id, company_id, role, is_primary }), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/contacts/[id]/companies", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/contacts/[id]/companies", method: "POST" });
