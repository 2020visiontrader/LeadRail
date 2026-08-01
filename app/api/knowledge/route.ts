import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { knowledgeRepo } from '@/lib/crm';
import { assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
const FIELDS = ['brand_id','title','body','tags','status'];
const pick = (b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  try { return NextResponse.json(await knowledgeRepo.list(session.accountId, brandId)); }
  catch (error) { return errorResponse(error); }
}
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body: any = pick(await request.json());
    if (body.brand_id && !(await assertBrandOwned(body.brand_id, session.accountId))) return badRequest('unknown brand_id');
    body.account_id = session.accountId;
    return NextResponse.json(await knowledgeRepo.create(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/knowledge", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/knowledge", method: "POST" });
