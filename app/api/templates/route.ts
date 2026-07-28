import { NextRequest, NextResponse } from 'next/server';
import { getTemplates, createTemplate, dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/templates?accountId=...&brandId=(optional)
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  const brandId = request.nextUrl.searchParams.get('brandId') || undefined;
  if (!accountId) return badRequest('accountId is required');
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await getTemplates(accountId, brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.accountId || !body?.name || !body?.body) {
      return badRequest('accountId, name, and body are required');
    }
    const tpl = await createTemplate({
      account_id: body.accountId,
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
