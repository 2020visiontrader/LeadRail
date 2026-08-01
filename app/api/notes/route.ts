import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getNotes, createNote } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','body','contact_id','company_id','deal_id','author_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const p = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await getNotes(session.accountId, {
      contactId: p.get('contactId') || undefined,
      dealId: p.get('dealId') || undefined,
      companyId: p.get('companyId') || undefined,
    }));
  } catch (error) { return errorResponse(error); }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = pick(await request.json());
    if (!body.body) return badRequest('body is required');
    body.account_id = session.accountId;
    return NextResponse.json(await createNote(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/notes", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/notes", method: "POST" });
