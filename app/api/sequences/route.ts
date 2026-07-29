import { NextRequest, NextResponse } from 'next/server';
import { listSequences, createSequence } from '@/lib/sequences';
import { dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  if (!dbReady()) return NextResponse.json([]);
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    return NextResponse.json(await listSequences(brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.brandId || !body?.name) return badRequest('brandId and name are required');
    if (!(await assertBrandOwned(body.brandId, session.accountId))) return badRequest('unknown brandId');
    const seq = await createSequence({
      account_id: session.accountId,
      brand_id: body.brandId,
      name: String(body.name),
      channel: body.channel,
      is_active: body.is_active,
      steps: Array.isArray(body.steps) ? body.steps : [],
    });
    return NextResponse.json(seq, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
