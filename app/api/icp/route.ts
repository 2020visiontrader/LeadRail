import { NextRequest, NextResponse } from 'next/server';
import { listIcpProfiles, createIcpProfile } from '@/lib/icp';
import { dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/icp?brandId= — list saved ICP profiles for the account (optionally brand-filtered).
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (brandId && !(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    return NextResponse.json(await listIcpProfiles(session.accountId, brandId));
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/icp  body: { name, query, brandId? }
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.name || !body?.query || typeof body.query !== 'object') {
      return badRequest('name and query are required');
    }
    if (body.brandId && !(await assertBrandOwned(body.brandId, session.accountId))) {
      return badRequest('unknown brandId');
    }
    const profile = await createIcpProfile({
      account_id: session.accountId,
      brand_id: body.brandId ?? null,
      name: String(body.name),
      query: body.query,
    });
    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
