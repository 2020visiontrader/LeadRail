import { NextRequest, NextResponse } from 'next/server';
import { getIcpProfile, updateIcpProfile, deleteIcpProfile } from '@/lib/icp';
import { dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await getIcpProfile(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error, 404, 'ICP profile not found');
  }
}

export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (body?.brandId && !(await assertBrandOwned(body.brandId, session.accountId))) {
      return badRequest('unknown brandId');
    }
    const updated = await updateIcpProfile(ctx.params.id, session.accountId, {
      name: body?.name,
      query: body?.query,
      brand_id: body?.brandId,
    });
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, 404, 'ICP profile not found');
  }
}

export async function DELETE(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteIcpProfile(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error, 404, 'ICP profile not found');
  }
}
