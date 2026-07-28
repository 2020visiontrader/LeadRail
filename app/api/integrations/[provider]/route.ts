import { NextRequest, NextResponse } from 'next/server';
import { dbReady, deleteConnection } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// DELETE /api/integrations/:provider?accountId=... — disconnect.
export async function DELETE(request: NextRequest, ctx: { params: { provider: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  const accountId = request.nextUrl.searchParams.get('accountId');
  if (!accountId) return badRequest('accountId is required');
  try {
    const result = await deleteConnection(accountId, ctx.params.provider);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
