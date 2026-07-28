import { NextRequest, NextResponse } from 'next/server';
import { listSequences, createSequence } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await listSequences(brandId));
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
    if (!body?.accountId || !body?.brandId || !body?.name) {
      return badRequest('accountId, brandId, and name are required');
    }
    const seq = await createSequence({
      account_id: body.accountId,
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
