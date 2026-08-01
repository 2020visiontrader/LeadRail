import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getTemplates, createTemplate, dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId') || undefined;
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await getTemplates(session.accountId, brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.name || !body?.body) return badRequest('name and body are required');
    if (body.brandId && !(await assertBrandOwned(body.brandId, session.accountId))) return badRequest('unknown brandId');
    const tpl = await createTemplate({
      account_id: session.accountId,
      brand_id: body.brandId ?? null,
      name: String(body.name),
      category: body.category ?? null,
      subject: body.subject ?? null,
      body: String(body.body),
    });
    return NextResponse.json(tpl, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/templates", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/templates", method: "POST" });
