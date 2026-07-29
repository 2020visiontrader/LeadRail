import { NextRequest, NextResponse } from 'next/server';
import { getNotes, createNote } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const FIELDS = ['brand_id','body','contact_id','company_id','deal_id','author_email'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));

export async function GET(request: NextRequest) {
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

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = pick(await request.json());
    if (!body.body) return badRequest('body is required');
    body.account_id = session.accountId;
    return NextResponse.json(await createNote(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
